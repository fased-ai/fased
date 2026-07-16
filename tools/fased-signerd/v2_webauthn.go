package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-webauthn/webauthn/protocol"
	webauthnlib "github.com/go-webauthn/webauthn/webauthn"
	bolt "go.etcd.io/bbolt"
)

const (
	signerWebAuthnRegistrationTTL = 5 * time.Minute
	signerWebAuthnReviewTTL       = 2 * time.Minute
	signerWebAuthnProofTTL        = 45 * time.Second
	signerWebAuthnMaxResponse     = 256 << 10
	signerReviewMaxIntentBytes    = 64 << 10
	signerReviewMaxJSONDepth      = 16
	signerWebAuthnMaxCredentials  = 16
	signerWebAuthnMaxChallenges   = 128

	signerWebAuthnChallengePending  = "pending"
	signerWebAuthnChallengeConsumed = "consumed"

	signerWebAuthnChallengeRegistration = "registration"
	signerWebAuthnChallengeReview       = "review"

	signerReviewProofPending  = "pending"
	signerReviewProofConsumed = "consumed"
)

var signerWebAuthnUserIDKeyV2 = []byte("webauthnUserID")

// signerWebAuthnServiceV2 is the signer-owned relying party. The Gateway only
// relays opaque WebAuthn ceremony data. It cannot choose the RP ID, origins,
// credential public keys, counters, challenge bindings, or authorization state.
type signerWebAuthnServiceV2 struct {
	store    *signerStoreV2
	provider *webauthnlib.WebAuthn
	rpID     string
	origins  []string
	enabled  bool
}

type signerWebAuthnUserV2 struct {
	id          []byte
	credentials []webauthnlib.Credential
}

func (u signerWebAuthnUserV2) WebAuthnID() []byte {
	return bytes.Clone(u.id)
}

func (u signerWebAuthnUserV2) WebAuthnName() string {
	return "wallet-operator"
}

func (u signerWebAuthnUserV2) WebAuthnDisplayName() string {
	return "Fased Wallet Operator"
}

func (u signerWebAuthnUserV2) WebAuthnCredentials() []webauthnlib.Credential {
	return append([]webauthnlib.Credential(nil), u.credentials...)
}

type signerWebAuthnCredentialRecordV2 struct {
	Credential webauthnlib.Credential `json:"credential"`
	Label      string                 `json:"label"`
	CreatedAt  string                 `json:"createdAt"`
	LastUsedAt string                 `json:"lastUsedAt,omitempty"`
}

type signerWebAuthnCredentialMetadataV2 struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	CreatedAt  string `json:"createdAt"`
	LastUsedAt string `json:"lastUsedAt,omitempty"`
}

type signerReviewBindingV2 struct {
	RequestID         string          `json:"requestId"`
	WalletID          string          `json:"walletId"`
	Role              string          `json:"role"`
	IntentType        string          `json:"intentType"`
	IntentDigest      string          `json:"intentDigest"`
	SemanticIntent    json.RawMessage `json:"semanticIntent"`
	TransactionDigest string          `json:"transactionDigest"`
	PolicyHash        string          `json:"policyHash"`
	Nonce             string          `json:"nonce"`
	IssuedAt          string          `json:"issuedAt"`
	ExpiresAt         string          `json:"expiresAt"`
}

type signerWebAuthnChallengeV2 struct {
	ID         string                  `json:"id"`
	Kind       string                  `json:"kind"`
	State      string                  `json:"state"`
	Session    webauthnlib.SessionData `json:"session"`
	Label      string                  `json:"label,omitempty"`
	Binding    *signerReviewBindingV2  `json:"binding,omitempty"`
	CreatedAt  string                  `json:"createdAt"`
	ExpiresAt  string                  `json:"expiresAt"`
	ConsumedAt string                  `json:"consumedAt,omitempty"`
}

type signerReviewProofRecordV2 struct {
	ID           string                `json:"id"`
	State        string                `json:"state"`
	Binding      signerReviewBindingV2 `json:"binding"`
	CredentialID string                `json:"credentialId"`
	AuthorizedAt string                `json:"authorizedAt"`
	ExpiresAt    string                `json:"expiresAt"`
	ConsumedAt   string                `json:"consumedAt,omitempty"`
}

// signerWebAuthnProofReferenceV2 is intentionally only a random opaque handle.
// The complete immutable proof is held in the signer-owned bbolt database and
// is consumed atomically after an exact binding match.
type signerWebAuthnProofReferenceV2 struct {
	ProofID string `json:"proofId"`
}

type signerWebAuthnAuthorizationEnvelopeV2 struct {
	Type  string                         `json:"type"`
	Proof signerWebAuthnProofReferenceV2 `json:"proof"`
}

type signerWebAuthnRegistrationBeginRequestV2 struct {
	Label string `json:"label,omitempty"`
}

type signerWebAuthnRegistrationFinishRequestV2 struct {
	ChallengeID string          `json:"challengeId"`
	Credential  json.RawMessage `json:"credential"`
}

type signerReviewAuthorizationBeginRequestV2 struct {
	RequestID string `json:"requestId"`
}

type signerReviewAuthorizationFinishRequestV2 struct {
	ChallengeID string          `json:"challengeId"`
	Credential  json.RawMessage `json:"credential"`
}

type signerWebAuthnRegistrationBeginResultV2 struct {
	ChallengeID string                       `json:"challengeId"`
	ExpiresAt   string                       `json:"expiresAt"`
	Options     *protocol.CredentialCreation `json:"options"`
}

type signerWebAuthnRegistrationFinishResultV2 struct {
	Credential signerWebAuthnCredentialMetadataV2 `json:"credential"`
}

type signerReviewAuthorizationBeginResultV2 struct {
	ChallengeID string                        `json:"challengeId"`
	ExpiresAt   string                        `json:"expiresAt"`
	Binding     signerReviewBindingV2         `json:"binding"`
	Options     *protocol.CredentialAssertion `json:"options"`
}

type signerReviewAuthorizationFinishResultV2 struct {
	Authorization signerWebAuthnAuthorizationEnvelopeV2 `json:"authorization"`
	Binding       signerReviewBindingV2                 `json:"binding"`
	CredentialID  string                                `json:"credentialId"`
	ExpiresAt     string                                `json:"expiresAt"`
}

type signerWebAuthnHealthV2 struct {
	Configured      bool     `json:"configured"`
	RPID            string   `json:"rpId,omitempty"`
	Origins         []string `json:"origins,omitempty"`
	CredentialCount int      `json:"credentialCount"`
	Ready           bool     `json:"ready"`
}

func newSignerWebAuthnServiceV2(store *signerStoreV2, rpID, originList string) (*signerWebAuthnServiceV2, error) {
	service := &signerWebAuthnServiceV2{store: store}
	rpID = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(rpID), "."))
	originList = strings.TrimSpace(originList)
	if rpID == "" && originList == "" {
		return service, nil
	}
	if rpID == "" || originList == "" {
		return nil, errors.New("WebAuthn requires both --webauthn-rp-id and --webauthn-origins")
	}
	origins, err := normalizeSignerWebAuthnOriginsV2(rpID, strings.Split(originList, ","))
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
			Login:        webauthnlib.TimeoutConfig{Timeout: signerWebAuthnReviewTTL},
			Registration: webauthnlib.TimeoutConfig{Timeout: signerWebAuthnRegistrationTTL},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("configure signer WebAuthn relying party: %w", err)
	}
	service.provider = provider
	service.rpID = rpID
	service.origins = origins
	service.enabled = true
	return service, nil
}

func normalizeSignerWebAuthnOriginsV2(rpID string, rawOrigins []string) ([]string, error) {
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
		if scheme != "https" && !(scheme == "http" && isLoopbackWebAuthnHostV2(hostname)) {
			return nil, fmt.Errorf("WebAuthn origin must use HTTPS except for localhost: %q", raw)
		}
		rpIsIP := net.ParseIP(rpID) != nil
		if hostname != rpID && (rpIsIP || !strings.HasSuffix(hostname, "."+rpID)) {
			return nil, fmt.Errorf("WebAuthn origin host %q is outside RP ID %q", hostname, rpID)
		}
		canonical := scheme + "://" + strings.ToLower(parsed.Host)
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		origins = append(origins, canonical)
	}
	if len(origins) == 0 {
		return nil, errors.New("WebAuthn requires at least one exact origin")
	}
	sort.Strings(origins)
	return origins, nil
}

func isLoopbackWebAuthnHostV2(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *signerWebAuthnServiceV2) requireEnabled() error {
	if s == nil || !s.enabled || s.provider == nil || s.store == nil || s.store.db == nil {
		return errors.New("signer WebAuthn is not configured by the host administrator")
	}
	return nil
}

func randomBase64URLV2(size int) (string, error) {
	if size < 16 {
		return "", errors.New("random identifier size is too small")
	}
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func signerWebAuthnCredentialKeyV2(id []byte) []byte {
	return []byte(base64.RawURLEncoding.EncodeToString(id))
}

func normalizeSignerWebAuthnLabelV2(raw string) (string, error) {
	label := strings.TrimSpace(raw)
	if label == "" {
		label = "Wallet Operator"
	}
	if !utf8.ValidString(label) || len(label) > 128 {
		return "", errors.New("WebAuthn credential label must be valid UTF-8 and at most 128 bytes")
	}
	return label, nil
}

func getOrCreateSignerWebAuthnUserIDV2(tx *bolt.Tx) ([]byte, error) {
	meta := tx.Bucket(bucketSignerMetaV2)
	if raw := meta.Get(signerWebAuthnUserIDKeyV2); raw != nil {
		if len(raw) < 32 || len(raw) > 64 {
			return nil, errors.New("invalid signer WebAuthn user identifier")
		}
		return bytes.Clone(raw), nil
	}
	userID := make([]byte, 32)
	if _, err := rand.Read(userID); err != nil {
		return nil, err
	}
	if err := meta.Put(signerWebAuthnUserIDKeyV2, userID); err != nil {
		return nil, err
	}
	return userID, nil
}

func loadSignerWebAuthnCredentialRecordsV2(tx *bolt.Tx) ([]signerWebAuthnCredentialRecordV2, error) {
	records := []signerWebAuthnCredentialRecordV2{}
	err := tx.Bucket(bucketSignerWebAuthnCredentialsV2).ForEach(func(key, raw []byte) error {
		if raw == nil {
			return nil
		}
		var record signerWebAuthnCredentialRecordV2
		if err := json.Unmarshal(raw, &record); err != nil {
			return fmt.Errorf("decode signer WebAuthn credential %q: %w", string(key), err)
		}
		if len(record.Credential.ID) == 0 || len(record.Credential.PublicKey) == 0 {
			return fmt.Errorf("invalid signer WebAuthn credential %q", string(key))
		}
		records = append(records, record)
		return nil
	})
	return records, err
}

func signerWebAuthnUserFromTxV2(tx *bolt.Tx) (signerWebAuthnUserV2, []signerWebAuthnCredentialRecordV2, error) {
	userID, err := getOrCreateSignerWebAuthnUserIDV2(tx)
	if err != nil {
		return signerWebAuthnUserV2{}, nil, err
	}
	records, err := loadSignerWebAuthnCredentialRecordsV2(tx)
	if err != nil {
		return signerWebAuthnUserV2{}, nil, err
	}
	credentials := make([]webauthnlib.Credential, 0, len(records))
	for _, record := range records {
		credentials = append(credentials, record.Credential)
	}
	return signerWebAuthnUserV2{id: userID, credentials: credentials}, records, nil
}

func putSignerWebAuthnChallengeV2(tx *bolt.Tx, challenge signerWebAuthnChallengeV2) error {
	if challenge.ID == "" || challenge.State != signerWebAuthnChallengePending {
		return errors.New("invalid signer WebAuthn challenge")
	}
	encoded, err := json.Marshal(challenge)
	if err != nil {
		return err
	}
	bucket := tx.Bucket(bucketSignerWebAuthnChallengesV2)
	if bucket.Get([]byte(challenge.ID)) != nil {
		return errors.New("signer WebAuthn challenge collision")
	}
	return bucket.Put([]byte(challenge.ID), encoded)
}

func loadSignerWebAuthnChallengeV2(tx *bolt.Tx, challengeID string, now time.Time) (signerWebAuthnChallengeV2, error) {
	challengeID = strings.TrimSpace(challengeID)
	if challengeID == "" || len(challengeID) > 128 {
		return signerWebAuthnChallengeV2{}, errors.New("invalid signer WebAuthn challenge identifier")
	}
	bucket := tx.Bucket(bucketSignerWebAuthnChallengesV2)
	raw := bucket.Get([]byte(challengeID))
	if raw == nil {
		return signerWebAuthnChallengeV2{}, errors.New("signer WebAuthn challenge not found")
	}
	var challenge signerWebAuthnChallengeV2
	if err := json.Unmarshal(raw, &challenge); err != nil {
		return signerWebAuthnChallengeV2{}, errors.New("invalid stored signer WebAuthn challenge")
	}
	if challenge.State != signerWebAuthnChallengePending {
		return signerWebAuthnChallengeV2{}, errors.New("signer WebAuthn challenge is not pending")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, challenge.ExpiresAt)
	if err != nil || !expiresAt.After(now) {
		return signerWebAuthnChallengeV2{}, errors.New("signer WebAuthn challenge expired")
	}
	return challenge, nil
}

func saveSignerWebAuthnChallengeV2(tx *bolt.Tx, challenge signerWebAuthnChallengeV2) error {
	encoded, err := json.Marshal(challenge)
	if err != nil {
		return err
	}
	return tx.Bucket(bucketSignerWebAuthnChallengesV2).Put([]byte(challenge.ID), encoded)
}

func pruneSignerWebAuthnStateV2(tx *bolt.Tx, now time.Time) (int, error) {
	activeChallenges := 0
	challengeCursor := tx.Bucket(bucketSignerWebAuthnChallengesV2).Cursor()
	for key, raw := challengeCursor.First(); key != nil; key, raw = challengeCursor.Next() {
		var challenge signerWebAuthnChallengeV2
		if err := json.Unmarshal(raw, &challenge); err != nil {
			return 0, errors.New("invalid stored signer WebAuthn challenge")
		}
		expiresAt, err := time.Parse(time.RFC3339Nano, challenge.ExpiresAt)
		if err != nil {
			return 0, errors.New("invalid stored signer WebAuthn challenge expiry")
		}
		if challenge.State != signerWebAuthnChallengePending || !expiresAt.After(now) {
			if err := challengeCursor.Delete(); err != nil {
				return 0, err
			}
			continue
		}
		activeChallenges++
	}
	proofCursor := tx.Bucket(bucketSignerReviewProofsV2).Cursor()
	for key, raw := proofCursor.First(); key != nil; key, raw = proofCursor.Next() {
		var proof signerReviewProofRecordV2
		if err := json.Unmarshal(raw, &proof); err != nil {
			return 0, errors.New("invalid stored review authorization proof")
		}
		expiresAt, err := time.Parse(time.RFC3339Nano, proof.ExpiresAt)
		if err != nil {
			return 0, errors.New("invalid stored review authorization proof expiry")
		}
		if proof.State != signerReviewProofPending || !expiresAt.After(now) {
			if err := proofCursor.Delete(); err != nil {
				return 0, err
			}
		}
	}
	return activeChallenges, nil
}

func (s *signerWebAuthnServiceV2) beginRegistration(label string) (signerWebAuthnRegistrationBeginResultV2, error) {
	if err := s.requireEnabled(); err != nil {
		return signerWebAuthnRegistrationBeginResultV2{}, err
	}
	label, err := normalizeSignerWebAuthnLabelV2(label)
	if err != nil {
		return signerWebAuthnRegistrationBeginResultV2{}, err
	}
	var result signerWebAuthnRegistrationBeginResultV2
	err = s.store.db.Update(func(tx *bolt.Tx) error {
		now := s.store.now().UTC()
		activeChallenges, err := pruneSignerWebAuthnStateV2(tx, now)
		if err != nil {
			return err
		}
		if activeChallenges >= signerWebAuthnMaxChallenges {
			return errors.New("too many pending signer WebAuthn challenges")
		}
		user, records, err := signerWebAuthnUserFromTxV2(tx)
		if err != nil {
			return err
		}
		if len(records) >= signerWebAuthnMaxCredentials {
			return errors.New("signer WebAuthn credential limit reached")
		}
		exclusions := webauthnlib.Credentials(user.credentials).CredentialDescriptors()
		options, session, err := s.provider.BeginRegistration(
			user,
			webauthnlib.WithExclusions(exclusions),
			webauthnlib.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
				ResidentKey:      protocol.ResidentKeyRequirementPreferred,
				UserVerification: protocol.VerificationRequired,
			}),
			webauthnlib.WithConveyancePreference(protocol.PreferNoAttestation),
		)
		if err != nil {
			return err
		}
		challengeID, err := randomBase64URLV2(18)
		if err != nil {
			return err
		}
		expiresAt := now.Add(signerWebAuthnRegistrationTTL)
		challenge := signerWebAuthnChallengeV2{
			ID:        challengeID,
			Kind:      signerWebAuthnChallengeRegistration,
			State:     signerWebAuthnChallengePending,
			Session:   *session,
			Label:     label,
			CreatedAt: timestampV2(now),
			ExpiresAt: timestampV2(expiresAt),
		}
		if err := putSignerWebAuthnChallengeV2(tx, challenge); err != nil {
			return err
		}
		result = signerWebAuthnRegistrationBeginResultV2{
			ChallengeID: challengeID,
			ExpiresAt:   challenge.ExpiresAt,
			Options:     options,
		}
		return nil
	})
	return result, err
}

func validateSignerWebAuthnResponseSizeV2(raw json.RawMessage) error {
	if len(raw) == 0 {
		return errors.New("WebAuthn credential response is required")
	}
	if len(raw) > signerWebAuthnMaxResponse {
		return errors.New("WebAuthn credential response is too large")
	}
	return nil
}

func signerWebAuthnCredentialMetadataFromRecordV2(record signerWebAuthnCredentialRecordV2) signerWebAuthnCredentialMetadataV2 {
	return signerWebAuthnCredentialMetadataV2{
		ID:         base64.RawURLEncoding.EncodeToString(record.Credential.ID),
		Label:      record.Label,
		CreatedAt:  record.CreatedAt,
		LastUsedAt: record.LastUsedAt,
	}
}

func (s *signerWebAuthnServiceV2) finishRegistration(body signerWebAuthnRegistrationFinishRequestV2) (signerWebAuthnRegistrationFinishResultV2, error) {
	if err := s.requireEnabled(); err != nil {
		return signerWebAuthnRegistrationFinishResultV2{}, err
	}
	if err := validateSignerWebAuthnResponseSizeV2(body.Credential); err != nil {
		return signerWebAuthnRegistrationFinishResultV2{}, err
	}
	var result signerWebAuthnRegistrationFinishResultV2
	err := s.store.db.Update(func(tx *bolt.Tx) error {
		now := s.store.now().UTC()
		challenge, err := loadSignerWebAuthnChallengeV2(tx, body.ChallengeID, now)
		if err != nil {
			return err
		}
		if challenge.Kind != signerWebAuthnChallengeRegistration || challenge.Binding != nil {
			return errors.New("signer WebAuthn challenge is not a registration ceremony")
		}
		user, _, err := signerWebAuthnUserFromTxV2(tx)
		if err != nil {
			return err
		}
		parsed, err := protocol.ParseCredentialCreationResponseBytes(body.Credential)
		if err != nil {
			return errors.New("invalid WebAuthn registration response")
		}
		credential, err := s.provider.CreateCredential(user, challenge.Session, parsed)
		if err != nil {
			return fmt.Errorf("verify WebAuthn registration: %w", err)
		}
		if credential == nil || len(credential.ID) == 0 || len(credential.PublicKey) == 0 {
			return errors.New("WebAuthn attestation did not contain a credential public key")
		}
		if !credential.Flags.UserPresent || !credential.Flags.UserVerified {
			return errors.New("WebAuthn registration requires user presence and verification")
		}
		key := signerWebAuthnCredentialKeyV2(credential.ID)
		credentials := tx.Bucket(bucketSignerWebAuthnCredentialsV2)
		if credentials.Get(key) != nil {
			return errors.New("WebAuthn credential is already enrolled")
		}
		record := signerWebAuthnCredentialRecordV2{
			Credential: *credential,
			Label:      challenge.Label,
			CreatedAt:  timestampV2(now),
		}
		encoded, err := json.Marshal(record)
		if err != nil {
			return err
		}
		if err := credentials.Put(key, encoded); err != nil {
			return err
		}
		challenge.State = signerWebAuthnChallengeConsumed
		challenge.ConsumedAt = timestampV2(now)
		if err := saveSignerWebAuthnChallengeV2(tx, challenge); err != nil {
			return err
		}
		result.Credential = signerWebAuthnCredentialMetadataFromRecordV2(record)
		return nil
	})
	return result, err
}

func (s *signerWebAuthnServiceV2) listCredentials() ([]signerWebAuthnCredentialMetadataV2, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	metadata := []signerWebAuthnCredentialMetadataV2{}
	err := s.store.db.View(func(tx *bolt.Tx) error {
		records, err := loadSignerWebAuthnCredentialRecordsV2(tx)
		if err != nil {
			return err
		}
		for _, record := range records {
			metadata = append(metadata, signerWebAuthnCredentialMetadataFromRecordV2(record))
		}
		sort.Slice(metadata, func(i, j int) bool { return metadata[i].ID < metadata[j].ID })
		return nil
	})
	return metadata, err
}

func (s *signerWebAuthnServiceV2) health() (signerWebAuthnHealthV2, error) {
	if s == nil || !s.enabled {
		return signerWebAuthnHealthV2{}, nil
	}
	credentials, err := s.listCredentials()
	if err != nil {
		return signerWebAuthnHealthV2{}, err
	}
	return signerWebAuthnHealthV2{
		Configured:      true,
		RPID:            s.rpID,
		Origins:         append([]string(nil), s.origins...),
		CredentialCount: len(credentials),
		Ready:           len(credentials) > 0,
	}, nil
}

func normalizeSHA256DigestV2(raw, field string) (string, error) {
	value := strings.TrimSpace(raw)
	if len(value) != len("sha256:")+64 || !strings.HasPrefix(value, "sha256:") {
		return "", fmt.Errorf("%s must be a sha256 digest", field)
	}
	hexPart := strings.TrimPrefix(value, "sha256:")
	decoded, err := hex.DecodeString(hexPart)
	if err != nil || len(decoded) != sha256.Size || hexPart != strings.ToLower(hexPart) {
		return "", fmt.Errorf("%s must be a lowercase sha256 digest", field)
	}
	return value, nil
}

func decodeReviewJSONValueV2(decoder *json.Decoder, depth int) (any, error) {
	if depth > signerReviewMaxJSONDepth {
		return nil, errors.New("semantic intent exceeds maximum JSON depth")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			object := map[string]any{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok || key == "" || len(key) > 256 {
					return nil, errors.New("semantic intent contains an invalid object key")
				}
				if _, exists := object[key]; exists {
					return nil, fmt.Errorf("semantic intent contains duplicate key %q", key)
				}
				child, err := decodeReviewJSONValueV2(decoder, depth+1)
				if err != nil {
					return nil, err
				}
				object[key] = child
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return object, nil
		case '[':
			array := []any{}
			for decoder.More() {
				child, err := decodeReviewJSONValueV2(decoder, depth+1)
				if err != nil {
					return nil, err
				}
				array = append(array, child)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return array, nil
		default:
			return nil, errors.New("semantic intent contains an unexpected JSON delimiter")
		}
	case string:
		if !utf8.ValidString(value) || len(value) > 16<<10 {
			return nil, errors.New("semantic intent contains an invalid or oversized string")
		}
		return value, nil
	case json.Number, bool, nil:
		return value, nil
	default:
		return nil, errors.New("semantic intent contains an unsupported JSON value")
	}
}

func normalizeSignerReviewIntentV2(raw json.RawMessage) (json.RawMessage, string, string, error) {
	if len(raw) == 0 || len(raw) > signerReviewMaxIntentBytes {
		return nil, "", "", errors.New("semantic intent is required and must not exceed 64 KiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := decodeReviewJSONValueV2(decoder, 0)
	if err != nil {
		return nil, "", "", fmt.Errorf("invalid semantic intent: %w", err)
	}
	if token, err := decoder.Token(); !errors.Is(err, io.EOF) || token != nil {
		return nil, "", "", errors.New("semantic intent must contain exactly one JSON value")
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, "", "", errors.New("semantic intent must be a JSON object")
	}
	intentType, ok := object["type"].(string)
	intentType = strings.TrimSpace(intentType)
	if !ok || intentType == "" || len(intentType) > 128 {
		return nil, "", "", errors.New("semantic intent requires a bounded string type")
	}
	canonical, err := json.Marshal(object)
	if err != nil {
		return nil, "", "", err
	}
	digest := sha256.Sum256(canonical)
	return json.RawMessage(canonical), intentType, "sha256:" + hex.EncodeToString(digest[:]), nil
}

func reviewBindingFromStoredReviewV2(review signerReviewV2, policy signerPolicyV2) (signerReviewBindingV2, error) {
	if review.State != jupiterReviewPreparedV2 {
		return signerReviewBindingV2{}, fmt.Errorf("signer review is already %s", review.State)
	}
	if review.Mode != jupiterReviewModeReviewedV2 {
		return signerReviewBindingV2{}, errors.New("WebAuthn authorization requires a reviewed-mode signer review")
	}
	if review.PolicyHash != policy.Hash || review.WalletID != policy.WalletID {
		return signerReviewBindingV2{}, errors.New("prepared signer review policy is no longer current")
	}
	canonicalStoredIntent, _, _, err := normalizeSignerReviewIntentV2(review.SemanticIntent)
	if err != nil {
		return signerReviewBindingV2{}, errors.New("stored signer review semantic intent is invalid")
	}
	var storedIntent signerIntentV2
	if err := decodeSignerRequestV2(canonicalStoredIntent, &storedIntent); err != nil {
		return signerReviewBindingV2{}, errors.New("stored signer review semantic intent is invalid")
	}
	normalizedIntent, err := normalizeSignerIntentV2(storedIntent)
	if err != nil || normalizedIntent.Intent.Type != review.IntentType || normalizedIntent.Digest != review.IntentDigest {
		return signerReviewBindingV2{}, errors.New("stored signer review semantic intent is inconsistent")
	}
	if err := validateReviewPolicyV2(policy, normalizedIntent); err != nil {
		return signerReviewBindingV2{}, err
	}
	semanticIntent, err := json.Marshal(normalizedIntent.Intent)
	if err != nil {
		return signerReviewBindingV2{}, errors.New("stored signer review semantic intent is invalid")
	}
	transactionDigest, err := normalizeSHA256DigestV2(review.TransactionDigest, "transactionDigest")
	if err != nil {
		return signerReviewBindingV2{}, errors.New("stored signer review transaction digest is invalid")
	}
	if _, err := normalizeTransactionEnvelopeV2(review.Transaction); err != nil {
		return signerReviewBindingV2{}, errors.New("stored signer review transaction envelope is invalid")
	}
	if strings.TrimSpace(review.Nonce) == "" || strings.TrimSpace(review.IssuedAt) == "" || strings.TrimSpace(review.ExpiresAt) == "" {
		return signerReviewBindingV2{}, errors.New("stored signer review binding is incomplete")
	}
	return signerReviewBindingV2{
		RequestID:         review.RequestID,
		WalletID:          review.WalletID,
		Role:              policy.Role,
		IntentType:        normalizedIntent.Intent.Type,
		IntentDigest:      normalizedIntent.Digest,
		SemanticIntent:    semanticIntent,
		TransactionDigest: transactionDigest,
		PolicyHash:        policy.Hash,
		Nonce:             review.Nonce,
		IssuedAt:          review.IssuedAt,
		ExpiresAt:         review.ExpiresAt,
	}, nil
}

func loadReviewAndPolicyForAuthorizationV2(tx *bolt.Tx, walletID, requestID string, now time.Time) (signerReviewV2, signerPolicyV2, signerReviewBindingV2, error) {
	var review signerReviewV2
	rawReview := tx.Bucket(bucketSignerReviewsV2).Get([]byte(requestID))
	if rawReview == nil {
		return review, signerPolicyV2{}, signerReviewBindingV2{}, errors.New("signer review not found; review.prepare is required")
	}
	if err := json.Unmarshal(rawReview, &review); err != nil {
		return review, signerPolicyV2{}, signerReviewBindingV2{}, errors.New("invalid stored signer review")
	}
	if review.WalletID != walletID || review.RequestID != requestID {
		return review, signerPolicyV2{}, signerReviewBindingV2{}, errors.New("signer review wallet mismatch")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, review.ExpiresAt)
	if err != nil || !expiresAt.After(now) {
		return review, signerPolicyV2{}, signerReviewBindingV2{}, errors.New("signer review expired; prepare a fresh review")
	}
	var policy signerPolicyV2
	rawPolicy := tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID))
	if rawPolicy == nil {
		return review, policy, signerReviewBindingV2{}, errors.New("explicit signer policy required")
	}
	if err := json.Unmarshal(rawPolicy, &policy); err != nil {
		return review, policy, signerReviewBindingV2{}, errors.New("invalid stored signer policy")
	}
	binding, err := reviewBindingFromStoredReviewV2(review, policy)
	if err != nil {
		return review, policy, signerReviewBindingV2{}, err
	}
	return review, policy, binding, nil
}

func (s *signerWebAuthnServiceV2) beginReviewAuthorization(walletID string, body signerReviewAuthorizationBeginRequestV2) (signerReviewAuthorizationBeginResultV2, error) {
	if err := s.requireEnabled(); err != nil {
		return signerReviewAuthorizationBeginResultV2{}, err
	}
	if strings.TrimSpace(walletID) == "" {
		return signerReviewAuthorizationBeginResultV2{}, errors.New("walletId is required")
	}
	requestID, err := validateRequestIDV2(body.RequestID)
	if err != nil {
		return signerReviewAuthorizationBeginResultV2{}, err
	}
	walletID = normalizeWalletID(walletID)
	var result signerReviewAuthorizationBeginResultV2
	err = s.store.db.Update(func(tx *bolt.Tx) error {
		now := s.store.now().UTC()
		activeChallenges, err := pruneSignerWebAuthnStateV2(tx, now)
		if err != nil {
			return err
		}
		if activeChallenges >= signerWebAuthnMaxChallenges {
			return errors.New("too many pending signer WebAuthn challenges")
		}
		_, policy, binding, err := loadReviewAndPolicyForAuthorizationV2(tx, walletID, requestID, now)
		if err != nil {
			return err
		}
		if !containsStringV2(policy.Operations, binding.IntentType) {
			return fmt.Errorf("policy denies reviewed operation %s", binding.IntentType)
		}
		user, records, err := signerWebAuthnUserFromTxV2(tx)
		if err != nil {
			return err
		}
		if len(records) == 0 {
			return errors.New("no signer-owned WebAuthn credential is enrolled; from host administration, run 'fased-signerd admin webauthn registration begin --control-socket <signer-control.sock> --label <label>' and complete 'webauthn registration finish' through the same control socket; Gateway enrollment is intentionally unavailable")
		}
		options, session, err := s.provider.BeginLogin(user, webauthnlib.WithUserVerification(protocol.VerificationRequired))
		if err != nil {
			return err
		}
		challengeID, err := randomBase64URLV2(18)
		if err != nil {
			return err
		}
		challengeExpiresAt := now.Add(signerWebAuthnReviewTTL)
		reviewExpiresAt, err := time.Parse(time.RFC3339Nano, binding.ExpiresAt)
		if err != nil {
			return errors.New("stored signer review expiry is invalid")
		}
		if reviewExpiresAt.Before(challengeExpiresAt) {
			challengeExpiresAt = reviewExpiresAt
		}
		challenge := signerWebAuthnChallengeV2{
			ID:        challengeID,
			Kind:      signerWebAuthnChallengeReview,
			State:     signerWebAuthnChallengePending,
			Session:   *session,
			Binding:   &binding,
			CreatedAt: timestampV2(now),
			ExpiresAt: timestampV2(challengeExpiresAt),
		}
		if err := putSignerWebAuthnChallengeV2(tx, challenge); err != nil {
			return err
		}
		result = signerReviewAuthorizationBeginResultV2{
			ChallengeID: challengeID,
			ExpiresAt:   challenge.ExpiresAt,
			Binding:     binding,
			Options:     options,
		}
		return nil
	})
	return result, err
}

func findSignerWebAuthnCredentialRecordV2(records []signerWebAuthnCredentialRecordV2, id []byte) (signerWebAuthnCredentialRecordV2, bool) {
	for _, record := range records {
		if bytes.Equal(record.Credential.ID, id) {
			return record, true
		}
	}
	return signerWebAuthnCredentialRecordV2{}, false
}

func (s *signerWebAuthnServiceV2) finishReviewAuthorization(walletID string, body signerReviewAuthorizationFinishRequestV2) (signerReviewAuthorizationFinishResultV2, error) {
	if err := s.requireEnabled(); err != nil {
		return signerReviewAuthorizationFinishResultV2{}, err
	}
	if strings.TrimSpace(walletID) == "" {
		return signerReviewAuthorizationFinishResultV2{}, errors.New("walletId is required")
	}
	if err := validateSignerWebAuthnResponseSizeV2(body.Credential); err != nil {
		return signerReviewAuthorizationFinishResultV2{}, err
	}
	walletID = normalizeWalletID(walletID)
	var result signerReviewAuthorizationFinishResultV2
	err := s.store.db.Update(func(tx *bolt.Tx) error {
		now := s.store.now().UTC()
		challenge, err := loadSignerWebAuthnChallengeV2(tx, body.ChallengeID, now)
		if err != nil {
			return err
		}
		if challenge.Kind != signerWebAuthnChallengeReview || challenge.Binding == nil {
			return errors.New("signer WebAuthn challenge is not a reviewed authorization ceremony")
		}
		if challenge.Binding.WalletID != walletID {
			return errors.New("review authorization wallet mismatch")
		}
		_, _, currentBinding, err := loadReviewAndPolicyForAuthorizationV2(
			tx,
			walletID,
			challenge.Binding.RequestID,
			now,
		)
		if err != nil {
			return err
		}
		if !equalSignerReviewBindingV2(currentBinding, *challenge.Binding) {
			return errors.New("review authorization binding is no longer current")
		}
		user, records, err := signerWebAuthnUserFromTxV2(tx)
		if err != nil {
			return err
		}
		parsed, err := protocol.ParseCredentialRequestResponseBytes(body.Credential)
		if err != nil {
			return errors.New("invalid WebAuthn assertion response")
		}
		storedRecord, found := findSignerWebAuthnCredentialRecordV2(records, parsed.RawID)
		if !found {
			return errors.New("unknown signer WebAuthn credential")
		}
		credential, err := s.provider.ValidateLogin(user, challenge.Session, parsed)
		if err != nil {
			return fmt.Errorf("verify signer WebAuthn assertion: %w", err)
		}
		if credential == nil || !credential.Flags.UserPresent || !credential.Flags.UserVerified {
			return errors.New("review authorization requires user presence and verification")
		}
		if credential.Authenticator.CloneWarning {
			return errors.New("WebAuthn signature counter rollback detected")
		}
		storedRecord.Credential = *credential
		storedRecord.LastUsedAt = timestampV2(now)
		encodedCredential, err := json.Marshal(storedRecord)
		if err != nil {
			return err
		}
		if err := tx.Bucket(bucketSignerWebAuthnCredentialsV2).Put(signerWebAuthnCredentialKeyV2(credential.ID), encodedCredential); err != nil {
			return err
		}
		challenge.State = signerWebAuthnChallengeConsumed
		challenge.ConsumedAt = timestampV2(now)
		if err := saveSignerWebAuthnChallengeV2(tx, challenge); err != nil {
			return err
		}
		proofID, err := randomBase64URLV2(32)
		if err != nil {
			return err
		}
		bindingExpiry, err := time.Parse(time.RFC3339Nano, challenge.Binding.ExpiresAt)
		if err != nil {
			return errors.New("invalid review binding expiry")
		}
		proofExpiry := now.Add(signerWebAuthnProofTTL)
		if bindingExpiry.Before(proofExpiry) {
			proofExpiry = bindingExpiry
		}
		proof := signerReviewProofRecordV2{
			ID:           proofID,
			State:        signerReviewProofPending,
			Binding:      *challenge.Binding,
			CredentialID: base64.RawURLEncoding.EncodeToString(credential.ID),
			AuthorizedAt: timestampV2(now),
			ExpiresAt:    timestampV2(proofExpiry),
		}
		encodedProof, err := json.Marshal(proof)
		if err != nil {
			return err
		}
		proofs := tx.Bucket(bucketSignerReviewProofsV2)
		if proofs.Get([]byte(proofID)) != nil {
			return errors.New("review authorization proof collision")
		}
		if err := proofs.Put([]byte(proofID), encodedProof); err != nil {
			return err
		}
		result = signerReviewAuthorizationFinishResultV2{
			Authorization: signerWebAuthnAuthorizationEnvelopeV2{
				Type:  "webauthn",
				Proof: signerWebAuthnProofReferenceV2{ProofID: proofID},
			},
			Binding:      *challenge.Binding,
			CredentialID: proof.CredentialID,
			ExpiresAt:    proof.ExpiresAt,
		}
		return nil
	})
	return result, err
}

func equalSignerReviewBindingV2(left, right signerReviewBindingV2) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	if leftErr != nil || rightErr != nil || len(leftJSON) != len(rightJSON) {
		return false
	}
	return subtle.ConstantTimeCompare(leftJSON, rightJSON) == 1
}

// verifyAndConsumeReviewProofV2 atomically consumes a signer-owned authorization
// proof. Callers must invoke it only after semantic transaction validation and
// immediately before signing the exact transaction represented by the binding.
func (s *signerWebAuthnServiceV2) verifyAndConsumeReviewProofV2(expected signerReviewBindingV2, authorization *signerWebAuthnProofReferenceV2) error {
	if err := s.requireEnabled(); err != nil {
		return err
	}
	if authorization == nil || strings.TrimSpace(authorization.ProofID) == "" {
		return errors.New("reviewed signing requires a signer-owned WebAuthn authorization proof")
	}
	proofID := strings.TrimSpace(authorization.ProofID)
	if len(proofID) > 128 {
		return errors.New("invalid review authorization proof identifier")
	}
	return s.store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerReviewProofsV2)
		raw := bucket.Get([]byte(proofID))
		if raw == nil {
			return errors.New("review authorization proof not found")
		}
		var proof signerReviewProofRecordV2
		if err := json.Unmarshal(raw, &proof); err != nil {
			return errors.New("invalid stored review authorization proof")
		}
		if proof.State != signerReviewProofPending {
			return errors.New("review authorization proof is not pending")
		}
		now := s.store.now().UTC()
		expiresAt, err := time.Parse(time.RFC3339Nano, proof.ExpiresAt)
		if err != nil || !expiresAt.After(now) {
			return errors.New("review authorization proof expired")
		}
		if !equalSignerReviewBindingV2(proof.Binding, expected) {
			return errors.New("review authorization proof binding mismatch")
		}
		rawPolicy := tx.Bucket(bucketSignerPoliciesV2).Get([]byte(expected.WalletID))
		if rawPolicy == nil {
			return errors.New("explicit signer policy required")
		}
		var currentPolicy signerPolicyV2
		if err := json.Unmarshal(rawPolicy, &currentPolicy); err != nil {
			return errors.New("invalid stored signer policy")
		}
		if currentPolicy.Role != expected.Role || subtle.ConstantTimeCompare([]byte(currentPolicy.Hash), []byte(expected.PolicyHash)) != 1 {
			return errors.New("review authorization policy is no longer current")
		}
		proof.State = signerReviewProofConsumed
		proof.ConsumedAt = timestampV2(now)
		encoded, err := json.Marshal(proof)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(proof.ID), encoded)
	})
}
