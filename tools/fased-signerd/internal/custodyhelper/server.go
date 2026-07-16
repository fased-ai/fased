package custodyhelper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Server struct {
	store          Storage
	allowedOrigins map[string]bool
}

// NewHandler starts in diagnostics-only mode. Storage routes require an exact
// gateway-origin allowlist through NewHandlerWithOrigins.
func NewHandler(store Storage) http.Handler {
	handler, err := NewHandlerWithOrigins(store, nil)
	if err != nil {
		panic(err)
	}
	return handler
}

func NewHandlerWithOrigins(store Storage, origins []string) (http.Handler, error) {
	allowedOrigins := make(map[string]bool, len(origins))
	for _, raw := range origins {
		origin, err := normalizeGatewayOrigin(raw)
		if err != nil {
			return nil, fmt.Errorf("invalid custody helper gateway origin: %w", err)
		}
		allowedOrigins[origin] = true
	}
	server := &Server{store: store, allowedOrigins: allowedOrigins}
	mux := http.NewServeMux()
	mux.HandleFunc(HealthPath, server.handleHealth)
	mux.HandleFunc(DeviceShareStatusPath, server.handleStatus)
	mux.HandleFunc(DeviceShareStorePath, server.handleStore)
	mux.HandleFunc(DeviceShareLoadPath, server.handleLoad)
	mux.HandleFunc(DeviceShareDeletePath, server.handleDelete)
	return server.withOriginAuthorization(mux), nil
}

func normalizeGatewayOrigin(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || strings.ContainsAny(value, "\r\n\t,") {
		return "", errors.New("origin is required")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.Opaque != "" || parsed.User != nil {
		return "", errors.New("origin must be an absolute HTTP(S) origin")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && scheme != "http" {
		return "", errors.New("origin must use HTTP or HTTPS")
	}
	if (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("origin must not contain a path, query, or fragment")
	}
	return scheme + "://" + strings.ToLower(parsed.Host), nil
}

func (s *Server) requestOrigin(r *http.Request) (string, bool) {
	origin, err := normalizeGatewayOrigin(r.Header.Get("Origin"))
	return origin, err == nil && s.allowedOrigins[origin]
}

func (s *Server) withOriginAuthorization(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		origin, allowed := s.requestOrigin(r)
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			if !allowed {
				http.Error(w, "gateway origin is not authorized", http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.URL.Path != HealthPath && !allowed {
			http.Error(w, "gateway origin is not authorized", http.StatusForbidden)
			return
		}
		if r.URL.Path == HealthPath && r.Header.Get("Origin") != "" && !allowed {
			http.Error(w, "gateway origin is not authorized", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	availableRoutes := []string{HealthPath}
	warning := strings.TrimSpace(s.store.Warning())
	if len(s.allowedOrigins) > 0 && s.store.StorageMode() != StorageModeUnavailable {
		availableRoutes = append(availableRoutes, StorageRoutes...)
	} else if len(s.allowedOrigins) == 0 {
		const disabledWarning = "device-share storage routes are disabled until an exact gateway origin is configured"
		if warning == "" {
			warning = disabledWarning
		} else {
			warning += "; " + disabledWarning
		}
	}
	response := HealthResponse{
		OK:                true,
		ProtocolVersion:   ProtocolVersion,
		Helper:            HelperName,
		Platform:          string(s.store.Platform()),
		StorageMode:       string(s.store.StorageMode()),
		AvailableRoutes:   availableRoutes,
		StoredWalletCount: s.store.StoredWalletCount(),
		Warning:           warning,
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	gatewayOrigin, ok := s.requireBoundGatewayOrigin(w, r, r.URL.Query().Get("gatewayOrigin"))
	if !ok {
		return
	}
	walletID := strings.TrimSpace(r.URL.Query().Get("walletId"))
	if walletID == "" {
		http.Error(w, "gatewayOrigin and walletId are required", http.StatusBadRequest)
		return
	}
	stored, err := s.store.HasStoredShare(r.Context(), gatewayOrigin, walletID)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, DeviceShareStatusResponse{
		OK:     true,
		Stored: stored,
	})
}

func (s *Server) handleStore(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var request DeviceShareStoreRequest
	if err := decodeStrictRequest(w, r, &request); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	gatewayOrigin, ok := s.requireBoundGatewayOrigin(w, r, request.GatewayOrigin)
	if !ok {
		return
	}
	record := normalizeRecord(StoredShareRecord{
		GatewayOrigin: gatewayOrigin,
		WalletID:      request.WalletID,
		DeviceShare:   request.DeviceShare,
		CredentialID:  derefString(request.CredentialID),
		DeviceLabel:   derefString(request.DeviceLabel),
	})
	if record.WalletID == "" || record.DeviceShare == "" {
		http.Error(w, "gatewayOrigin, walletId, and deviceShare are required", http.StatusBadRequest)
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	if err := s.store.Save(ctx, record); err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, DeviceShareStoreResponse{
		OK:          true,
		Stored:      true,
		StorageMode: string(s.store.StorageMode()),
	})
}

func (s *Server) handleLoad(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var request DeviceShareLoadRequest
	if err := decodeStrictRequest(w, r, &request); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	gatewayOrigin, ok := s.requireBoundGatewayOrigin(w, r, request.GatewayOrigin)
	if !ok {
		return
	}
	if strings.TrimSpace(request.WalletID) == "" {
		http.Error(w, "gatewayOrigin and walletId are required", http.StatusBadRequest)
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	record, err := s.store.Load(
		ctx,
		gatewayOrigin,
		request.WalletID,
		derefString(request.Prompt),
	)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, DeviceShareLoadResponse{
		OK:          true,
		DeviceShare: record.DeviceShare,
	})
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var request DeviceShareDeleteRequest
	if err := decodeStrictRequest(w, r, &request); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	gatewayOrigin, ok := s.requireBoundGatewayOrigin(w, r, request.GatewayOrigin)
	if !ok {
		return
	}
	if strings.TrimSpace(request.WalletID) == "" {
		http.Error(w, "gatewayOrigin and walletId are required", http.StatusBadRequest)
		return
	}
	ctx, cancel := withTimeout(r.Context())
	defer cancel()
	removed, err := s.store.Delete(ctx, gatewayOrigin, request.WalletID)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, DeviceShareDeleteResponse{
		OK:      true,
		Removed: removed,
	})
}

func (s *Server) requireBoundGatewayOrigin(w http.ResponseWriter, r *http.Request, claimed string) (string, bool) {
	origin, allowed := s.requestOrigin(r)
	if !allowed {
		http.Error(w, "gateway origin is not authorized", http.StatusForbidden)
		return "", false
	}
	claimedOrigin, err := normalizeGatewayOrigin(claimed)
	if err != nil || claimedOrigin != origin {
		http.Error(w, "gatewayOrigin must exactly match the authorized browser Origin", http.StatusForbidden)
		return "", false
	}
	return origin, true
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	return false
}

func decodeStrictRequest(w http.ResponseWriter, r *http.Request, out any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 32*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("trailing request data")
	}
	return nil
}

func withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 30*time.Second)
}

func writeStorageError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrUnavailable):
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	case errors.Is(err, ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
