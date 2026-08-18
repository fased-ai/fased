// Package webauthn owns signer WebAuthn relying-party configuration and ceremony
// verification. Durable ceremony state remains with the signer store.
package webauthn

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	webauthnlib "github.com/go-webauthn/webauthn/webauthn"
)

const (
	RegistrationTTL = 5 * time.Minute
	ReviewTTL       = 2 * time.Minute
)

// Credential and SessionData retain the provider's serialized representation.
// They are aliases so moving ceremony ownership does not alter bbolt bytes.
type Credential = webauthnlib.Credential
type SessionData = webauthnlib.SessionData

// RelyingParty deliberately does not expose the external WebAuthn provider.
type RelyingParty struct {
	provider *webauthnlib.WebAuthn
	rpID     string
	origins  []string
}

type user struct {
	id          []byte
	credentials []Credential
}

func (u user) WebAuthnID() []byte          { return bytes.Clone(u.id) }
func (u user) WebAuthnName() string        { return "wallet-operator" }
func (u user) WebAuthnDisplayName() string { return "Fased Wallet Operator" }
func (u user) WebAuthnCredentials() []Credential {
	return append([]Credential(nil), u.credentials...)
}

// New accepts the signer command-line configuration. An empty configuration is
// intentionally disabled; a partial configuration is rejected fail-closed.
func New(rpID, originList string) (*RelyingParty, error) {
	rpID = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(rpID), "."))
	originList = strings.TrimSpace(originList)
	if rpID == "" && originList == "" {
		return &RelyingParty{}, nil
	}
	if rpID == "" || originList == "" {
		return nil, errors.New("WebAuthn requires both --webauthn-rp-id and --webauthn-origins")
	}
	origins, err := NormalizeOrigins(rpID, strings.Split(originList, ","))
	if err != nil {
		return nil, err
	}
	provider, err := webauthnlib.New(&webauthnlib.Config{
		RPID:                  rpID,
		RPDisplayName:         "FasedAgent Wallet",
		RPOrigins:             origins,
		RPAllowCrossOrigin:    false,
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementPreferred,
			UserVerification: protocol.VerificationRequired,
		},
		Timeouts: webauthnlib.TimeoutsConfig{
			Login:        webauthnlib.TimeoutConfig{Timeout: ReviewTTL},
			Registration: webauthnlib.TimeoutConfig{Timeout: RegistrationTTL},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("configure signer WebAuthn relying party: %w", err)
	}
	return &RelyingParty{provider: provider, rpID: rpID, origins: origins}, nil
}

func (r *RelyingParty) Enabled() bool { return r != nil && r.provider != nil }
func (r *RelyingParty) RPID() string {
	if r == nil {
		return ""
	}
	return r.rpID
}
func (r *RelyingParty) Origins() []string {
	if r == nil {
		return nil
	}
	return append([]string(nil), r.origins...)
}

func NormalizeOrigins(rpID string, rawOrigins []string) ([]string, error) {
	seen := map[string]bool{}
	origins := make([]string, 0, len(rawOrigins))
	for _, raw := range rawOrigins {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return nil, errors.New("WebAuthn origin allowlist contains an empty origin")
		}
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return nil, fmt.Errorf("invalid WebAuthn origin %q", raw)
		}
		if parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, fmt.Errorf("WebAuthn origin must not include credentials, path, query, or fragment: %q", raw)
		}
		scheme := strings.ToLower(parsed.Scheme)
		hostname := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
		if scheme != "https" && !(scheme == "http" && IsLoopbackHost(hostname)) {
			return nil, fmt.Errorf("WebAuthn origin must use HTTPS except for localhost: %q", raw)
		}
		rpIsIP := net.ParseIP(rpID) != nil
		if hostname != rpID && (rpIsIP || !strings.HasSuffix(hostname, "."+rpID)) {
			return nil, fmt.Errorf("WebAuthn origin host %q is outside RP ID %q", hostname, rpID)
		}
		canonical := scheme + "://" + strings.ToLower(parsed.Host)
		if !seen[canonical] {
			seen[canonical] = true
			origins = append(origins, canonical)
		}
	}
	if len(origins) == 0 {
		return nil, errors.New("WebAuthn requires at least one exact origin")
	}
	sort.Strings(origins)
	return origins, nil
}

func IsLoopbackHost(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (r *RelyingParty) BeginRegistration(userID []byte, credentials []Credential) (*protocol.CredentialCreation, *SessionData, error) {
	if !r.Enabled() {
		return nil, nil, errors.New("signer WebAuthn is not configured by the host administrator")
	}
	u := user{id: bytes.Clone(userID), credentials: append([]Credential(nil), credentials...)}
	exclusions := webauthnlib.Credentials(u.credentials).CredentialDescriptors()
	return r.provider.BeginRegistration(u, webauthnlib.WithExclusions(exclusions), webauthnlib.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
		ResidentKey: protocol.ResidentKeyRequirementPreferred, UserVerification: protocol.VerificationRequired,
	}), webauthnlib.WithConveyancePreference(protocol.PreferNoAttestation))
}

func (r *RelyingParty) FinishRegistration(userID []byte, credentials []Credential, session SessionData, raw []byte) (*Credential, error) {
	if !r.Enabled() {
		return nil, errors.New("signer WebAuthn is not configured by the host administrator")
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(raw)
	if err != nil {
		return nil, errors.New("invalid WebAuthn registration response")
	}
	u := user{id: bytes.Clone(userID), credentials: append([]Credential(nil), credentials...)}
	credential, err := r.provider.CreateCredential(u, session, parsed)
	if err != nil {
		return nil, fmt.Errorf("verify WebAuthn registration: %w", err)
	}
	if credential == nil || len(credential.ID) == 0 || len(credential.PublicKey) == 0 {
		return nil, errors.New("WebAuthn attestation did not contain a credential public key")
	}
	if !credential.Flags.UserPresent || !credential.Flags.UserVerified {
		return nil, errors.New("WebAuthn registration requires user presence and verification")
	}
	return credential, nil
}

func (r *RelyingParty) BeginReviewAuthentication(userID []byte, credentials []Credential) (*protocol.CredentialAssertion, *SessionData, error) {
	if !r.Enabled() {
		return nil, nil, errors.New("signer WebAuthn is not configured by the host administrator")
	}
	u := user{id: bytes.Clone(userID), credentials: append([]Credential(nil), credentials...)}
	return r.provider.BeginLogin(u, webauthnlib.WithUserVerification(protocol.VerificationRequired))
}

func (r *RelyingParty) FinishReviewAuthentication(userID []byte, credentials []Credential, session SessionData, raw []byte) (*Credential, error) {
	if !r.Enabled() {
		return nil, errors.New("signer WebAuthn is not configured by the host administrator")
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(raw)
	if err != nil {
		return nil, errors.New("invalid WebAuthn assertion response")
	}
	found := false
	for _, credential := range credentials {
		if bytes.Equal(credential.ID, parsed.RawID) {
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("unknown signer WebAuthn credential")
	}
	u := user{id: bytes.Clone(userID), credentials: append([]Credential(nil), credentials...)}
	credential, err := r.provider.ValidateLogin(u, session, parsed)
	if err != nil {
		return nil, fmt.Errorf("verify signer WebAuthn assertion: %w", err)
	}
	if credential == nil || !credential.Flags.UserPresent || !credential.Flags.UserVerified {
		return nil, errors.New("review authorization requires user presence and verification")
	}
	if credential.Authenticator.CloneWarning {
		return nil, errors.New("WebAuthn signature counter rollback detected")
	}
	return credential, nil
}
