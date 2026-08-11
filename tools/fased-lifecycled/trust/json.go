package trust

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

const maxTrustDocumentSize = 1 << 20

type Key struct {
	KeyType   string `json:"keyType"`
	Scheme    string `json:"scheme"`
	PublicKey string `json:"publicKey"`
}

type Signature struct {
	KeyID     string `json:"keyId"`
	Signature string `json:"signature"`
}

type SigningKey struct {
	KeyID      string
	PrivateKey ed25519.PrivateKey
}

type rawEnvelope struct {
	SchemaVersion uint32          `json:"schemaVersion"`
	Signed        json.RawMessage `json:"signed"`
	Signatures    []Signature     `json:"signatures"`
}

func decodeStrict(data []byte, target any) error {
	if len(data) == 0 || len(data) > maxTrustDocumentSize {
		return errors.New("trust document is empty or exceeds its size limit")
	}
	if _, err := parseCanonicalInput(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trust document contains trailing JSON")
		}
		return err
	}
	return nil
}

func parseCanonicalInput(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := parseValue(decoder)
	if err != nil {
		return nil, err
	}
	if token, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, fmt.Errorf("unexpected trailing token %v", token)
		}
		return nil, err
	}
	return value, nil
}

func parseValue(decoder *json.Decoder) (any, error) {
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
				if !ok {
					return nil, errors.New("JSON object key is not a string")
				}
				if _, exists := object[key]; exists {
					return nil, fmt.Errorf("duplicate JSON field %q", key)
				}
				entry, err := parseValue(decoder)
				if err != nil {
					return nil, err
				}
				object[key] = entry
			}
			if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
				return nil, errors.New("unterminated JSON object")
			}
			return object, nil
		case '[':
			array := []any{}
			for decoder.More() {
				entry, err := parseValue(decoder)
				if err != nil {
					return nil, err
				}
				array = append(array, entry)
			}
			if end, err := decoder.Token(); err != nil || end != json.Delim(']') {
				return nil, errors.New("unterminated JSON array")
			}
			return array, nil
		default:
			return nil, errors.New("unexpected JSON delimiter")
		}
	case string, bool, nil:
		return value, nil
	case json.Number:
		if strings.ContainsAny(string(value), ".eE") {
			return nil, errors.New("trust metadata numbers must be integers")
		}
		integer, err := strconv.ParseInt(string(value), 10, 64)
		if err != nil || integer < 0 || integer > 9007199254740991 {
			return nil, errors.New("trust metadata integer is outside the safe range")
		}
		return value, nil
	default:
		return nil, errors.New("unsupported JSON value")
	}
}

func canonicalJSON(value any) ([]byte, error) {
	var out bytes.Buffer
	if err := writeCanonical(&out, value); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func canonicalStruct(value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	parsed, err := parseCanonicalInput(data)
	if err != nil {
		return nil, err
	}
	return canonicalJSON(parsed)
}

func writeCanonical(out *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		if typed {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case string:
		encoded, _ := json.Marshal(typed)
		out.Write(encoded)
	case json.Number:
		out.WriteString(string(typed))
	case []any:
		out.WriteByte('[')
		for index, entry := range typed {
			if index > 0 {
				out.WriteByte(',')
			}
			if err := writeCanonical(out, entry); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				out.WriteByte(',')
			}
			encoded, _ := json.Marshal(key)
			out.Write(encoded)
			out.WriteByte(':')
			if err := writeCanonical(out, typed[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return fmt.Errorf("unsupported canonical JSON type %T", value)
	}
	return nil
}

func signEnvelope(signed any, keys []SigningKey) ([]byte, error) {
	payload, err := canonicalStruct(signed)
	if err != nil {
		return nil, err
	}
	signatures := make([]Signature, 0, len(keys))
	seen := map[string]bool{}
	for _, key := range keys {
		if !isKeyID(key.KeyID) || len(key.PrivateKey) != ed25519.PrivateKeySize || seen[key.KeyID] {
			return nil, errors.New("signing key identity is invalid or duplicated")
		}
		seen[key.KeyID] = true
		signatures = append(signatures, Signature{KeyID: key.KeyID, Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key.PrivateKey, payload))})
	}
	sort.Slice(signatures, func(i, j int) bool { return signatures[i].KeyID < signatures[j].KeyID })
	return canonicalStruct(struct {
		SchemaVersion uint32      `json:"schemaVersion"`
		Signed        any         `json:"signed"`
		Signatures    []Signature `json:"signatures"`
	}{1, signed, signatures})
}

func verifyEnvelope(data []byte, keys map[string]ed25519.PublicKey) (rawEnvelope, map[string]bool, error) {
	var envelope rawEnvelope
	if err := decodeStrict(data, &envelope); err != nil {
		return envelope, nil, err
	}
	if envelope.SchemaVersion != 1 || len(envelope.Signatures) == 0 {
		return envelope, nil, errors.New("trust envelope is malformed")
	}
	signedValue, err := parseCanonicalInput(envelope.Signed)
	if err != nil {
		return envelope, nil, err
	}
	payload, err := canonicalJSON(signedValue)
	if err != nil {
		return envelope, nil, err
	}
	verified := map[string]bool{}
	prior := ""
	for _, signature := range envelope.Signatures {
		if !isKeyID(signature.KeyID) || (prior != "" && signature.KeyID <= prior) {
			return envelope, nil, errors.New("trust signatures must use unique sorted key IDs")
		}
		prior = signature.KeyID
		public, ok := keys[signature.KeyID]
		if !ok {
			return envelope, nil, errors.New("trust signature uses an unknown key")
		}
		bytes, err := base64.StdEncoding.Strict().DecodeString(signature.Signature)
		if err != nil || len(bytes) != ed25519.SignatureSize || !ed25519.Verify(public, payload, bytes) {
			return envelope, nil, errors.New("trust envelope contains an invalid Ed25519 signature")
		}
		verified[signature.KeyID] = true
	}
	return envelope, verified, nil
}

func digestDocument(data []byte) (string, error) {
	value, err := parseCanonicalInput(data)
	if err != nil {
		return "", err
	}
	canonical, err := canonicalJSON(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

func isKeyID(value string) bool {
	return len(value) == 64 && strings.IndexFunc(value, func(r rune) bool { return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') }) == -1
}
func sortStrings(values []string) { sort.Strings(values) }
