package custodyhelper

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testGatewayOrigin = "https://agent.example"

func authorizedRequest(method, target string, body *bytes.Reader) *http.Request {
	request := httptest.NewRequest(method, target, body)
	request.Header.Set("Origin", testGatewayOrigin)
	return request
}

type memoryStorage struct {
	platform    Platform
	storageMode StorageMode
	warning     string
	records     map[string]StoredShareRecord
}

func newMemoryStorage() *memoryStorage {
	return &memoryStorage{
		platform:    PlatformMock,
		storageMode: StorageModeMockMemory,
		records:     map[string]StoredShareRecord{},
	}
}

func (s *memoryStorage) key(origin string, walletID string) string {
	return trimOrEmpty(origin) + "\n" + trimOrEmpty(walletID)
}

func (s *memoryStorage) Platform() Platform       { return s.platform }
func (s *memoryStorage) StorageMode() StorageMode { return s.storageMode }
func (s *memoryStorage) Warning() string          { return s.warning }
func (s *memoryStorage) StoredWalletCount() int   { return len(s.records) }
func (s *memoryStorage) HasStoredShare(_ context.Context, origin string, walletID string) (bool, error) {
	_, ok := s.records[s.key(origin, walletID)]
	return ok, nil
}
func (s *memoryStorage) Save(_ context.Context, record StoredShareRecord) error {
	record = normalizeRecord(record)
	s.records[s.key(record.GatewayOrigin, record.WalletID)] = record
	return nil
}
func (s *memoryStorage) Load(_ context.Context, origin string, walletID string, _ string) (*StoredShareRecord, error) {
	record, ok := s.records[s.key(origin, walletID)]
	if !ok {
		return nil, ErrNotFound
	}
	return &record, nil
}
func (s *memoryStorage) Delete(_ context.Context, origin string, walletID string) (bool, error) {
	key := s.key(origin, walletID)
	_, ok := s.records[key]
	delete(s.records, key)
	return ok, nil
}

func TestServerHealthAndLifecycle(t *testing.T) {
	store := newMemoryStorage()
	handler, err := NewHandlerWithOrigins(store, []string{testGatewayOrigin})
	if err != nil {
		t.Fatal(err)
	}

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, HealthPath, nil))
	if health.Code != http.StatusOK {
		t.Fatalf("expected health ok, got %d", health.Code)
	}
	var healthPayload HealthResponse
	if err := json.Unmarshal(health.Body.Bytes(), &healthPayload); err != nil {
		t.Fatalf("decode health: %v", err)
	}
	if healthPayload.Platform != string(PlatformMock) {
		t.Fatalf("unexpected platform: %s", healthPayload.Platform)
	}
	if len(healthPayload.AvailableRoutes) != 5 {
		t.Fatalf("expected storage routes in health, got %v", healthPayload.AvailableRoutes)
	}

	storeReq := DeviceShareStoreRequest{
		GatewayOrigin: testGatewayOrigin,
		WalletID:      "wallet-payment",
		DeviceShare:   "device-share-secret",
	}
	storeBody, _ := json.Marshal(storeReq)
	storeRes := httptest.NewRecorder()
	handler.ServeHTTP(
		storeRes,
		authorizedRequest(http.MethodPost, DeviceShareStorePath, bytes.NewReader(storeBody)),
	)
	if storeRes.Code != http.StatusOK {
		t.Fatalf("expected store ok, got %d: %s", storeRes.Code, storeRes.Body.String())
	}

	statusRes := httptest.NewRecorder()
	handler.ServeHTTP(
		statusRes,
		authorizedRequest(
			http.MethodGet,
			DeviceShareStatusPath+"?gatewayOrigin=https%3A%2F%2Fagent.example&walletId=wallet-payment",
			bytes.NewReader(nil),
		),
	)
	if statusRes.Code != http.StatusOK {
		t.Fatalf("expected status ok, got %d", statusRes.Code)
	}
	var statusPayload DeviceShareStatusResponse
	if err := json.Unmarshal(statusRes.Body.Bytes(), &statusPayload); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if !statusPayload.Stored {
		t.Fatalf("expected stored=true after save")
	}

	loadBody, _ := json.Marshal(DeviceShareLoadRequest{
		GatewayOrigin: testGatewayOrigin,
		WalletID:      "wallet-payment",
	})
	loadRes := httptest.NewRecorder()
	handler.ServeHTTP(
		loadRes,
		authorizedRequest(http.MethodPost, DeviceShareLoadPath, bytes.NewReader(loadBody)),
	)
	if loadRes.Code != http.StatusOK {
		t.Fatalf("expected load ok, got %d: %s", loadRes.Code, loadRes.Body.String())
	}
	var loadPayload DeviceShareLoadResponse
	if err := json.Unmarshal(loadRes.Body.Bytes(), &loadPayload); err != nil {
		t.Fatalf("decode load: %v", err)
	}
	if loadPayload.DeviceShare != "device-share-secret" {
		t.Fatalf("unexpected device share: %s", loadPayload.DeviceShare)
	}

	deleteBody, _ := json.Marshal(DeviceShareDeleteRequest{
		GatewayOrigin: testGatewayOrigin,
		WalletID:      "wallet-payment",
	})
	deleteRes := httptest.NewRecorder()
	handler.ServeHTTP(
		deleteRes,
		authorizedRequest(http.MethodPost, DeviceShareDeletePath, bytes.NewReader(deleteBody)),
	)
	if deleteRes.Code != http.StatusOK {
		t.Fatalf("expected delete ok, got %d", deleteRes.Code)
	}
}

func TestUnavailableStorageHealth(t *testing.T) {
	handler, err := NewHandlerWithOrigins(&unavailableStorage{
		platform: PlatformLinux,
		warning:  "secret-tool not found",
	}, []string{testGatewayOrigin})
	if err != nil {
		t.Fatal(err)
	}

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, HealthPath, nil))
	if health.Code != http.StatusOK {
		t.Fatalf("expected health ok, got %d", health.Code)
	}
	var payload HealthResponse
	if err := json.Unmarshal(health.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode health: %v", err)
	}
	if payload.StorageMode != string(StorageModeUnavailable) {
		t.Fatalf("expected unavailable storage mode, got %s", payload.StorageMode)
	}
	if len(payload.AvailableRoutes) != 1 || payload.AvailableRoutes[0] != HealthPath {
		t.Fatalf("unexpected routes for unavailable helper: %v", payload.AvailableRoutes)
	}

	storeBody, _ := json.Marshal(DeviceShareStoreRequest{
		GatewayOrigin: testGatewayOrigin,
		WalletID:      "wallet-payment",
		DeviceShare:   "device-share-secret",
	})
	storeRes := httptest.NewRecorder()
	handler.ServeHTTP(
		storeRes,
		authorizedRequest(http.MethodPost, DeviceShareStorePath, bytes.NewReader(storeBody)),
	)
	if storeRes.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected store to fail when storage unavailable, got %d", storeRes.Code)
	}
}

func TestStorageRoutesFailClosedWithoutConfiguredOrigin(t *testing.T) {
	store := newMemoryStorage()
	handler := NewHandler(store)
	body, _ := json.Marshal(DeviceShareStoreRequest{
		GatewayOrigin: testGatewayOrigin,
		WalletID:      "vault",
		DeviceShare:   "must-not-be-stored",
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		authorizedRequest(http.MethodPost, DeviceShareStorePath, bytes.NewReader(body)),
	)
	if response.Code != http.StatusForbidden || len(store.records) != 0 {
		t.Fatalf("unconfigured helper accepted storage request: status=%d records=%d", response.Code, len(store.records))
	}

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, HealthPath, nil))
	var payload HealthResponse
	if err := json.Unmarshal(health.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.AvailableRoutes) != 1 || payload.AvailableRoutes[0] != HealthPath || !strings.Contains(payload.Warning, "disabled") {
		t.Fatalf("diagnostics-only health did not disclose the fail-closed state: %#v", payload)
	}
}

func TestStorageRoutesBindClaimedGatewayToBrowserOrigin(t *testing.T) {
	store := newMemoryStorage()
	handler, err := NewHandlerWithOrigins(store, []string{testGatewayOrigin})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(DeviceShareStoreRequest{
		GatewayOrigin: "https://different.example",
		WalletID:      "vault",
		DeviceShare:   "must-not-be-stored",
	})
	mismatch := httptest.NewRecorder()
	handler.ServeHTTP(
		mismatch,
		authorizedRequest(http.MethodPost, DeviceShareStorePath, bytes.NewReader(body)),
	)
	if mismatch.Code != http.StatusForbidden || len(store.records) != 0 {
		t.Fatalf("helper accepted mismatched claimed origin: status=%d records=%d", mismatch.Code, len(store.records))
	}

	foreign := httptest.NewRequest(http.MethodPost, DeviceShareStorePath, bytes.NewReader(body))
	foreign.Header.Set("Origin", "https://evil.example")
	foreignResponse := httptest.NewRecorder()
	handler.ServeHTTP(foreignResponse, foreign)
	if foreignResponse.Code != http.StatusForbidden || foreignResponse.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("helper authorized a foreign browser origin: status=%d cors=%q", foreignResponse.Code, foreignResponse.Header().Get("Access-Control-Allow-Origin"))
	}

	preflight := httptest.NewRequest(http.MethodOptions, DeviceShareStorePath, nil)
	preflight.Header.Set("Origin", testGatewayOrigin)
	preflightResponse := httptest.NewRecorder()
	handler.ServeHTTP(preflightResponse, preflight)
	if preflightResponse.Code != http.StatusNoContent || preflightResponse.Header().Get("Access-Control-Allow-Origin") != testGatewayOrigin {
		t.Fatalf("trusted preflight failed: status=%d cors=%q", preflightResponse.Code, preflightResponse.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestCustodyHelperRejectsInvalidOriginsAndRequestShapes(t *testing.T) {
	store := newMemoryStorage()
	for _, origin := range []string{"", "file:///tmp/x", "https://agent.example/path", "https://agent.example?x=1", "https://a.example,https://b.example"} {
		if _, err := NewHandlerWithOrigins(store, []string{origin}); err == nil {
			t.Fatalf("accepted invalid configured origin %q", origin)
		}
	}
	handler, err := NewHandlerWithOrigins(store, []string{testGatewayOrigin})
	if err != nil {
		t.Fatal(err)
	}
	unknownBody := bytes.NewBufferString(`{"gatewayOrigin":"https://agent.example","walletId":"vault","deviceShare":"secret","extra":true}`)
	request := httptest.NewRequest(http.MethodPost, DeviceShareStorePath, unknownBody)
	request.Header.Set("Origin", testGatewayOrigin)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || len(store.records) != 0 {
		t.Fatalf("accepted non-strict storage request: status=%d records=%d", response.Code, len(store.records))
	}
}
