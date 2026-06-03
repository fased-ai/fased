package custodyhelper

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

type Server struct {
	store Storage
}

func NewHandler(store Storage) http.Handler {
	server := &Server{store: store}
	mux := http.NewServeMux()
	mux.HandleFunc(HealthPath, server.handleHealth)
	mux.HandleFunc(DeviceShareStatusPath, server.handleStatus)
	mux.HandleFunc(DeviceShareStorePath, server.handleStore)
	mux.HandleFunc(DeviceShareLoadPath, server.handleLoad)
	mux.HandleFunc(DeviceShareDeletePath, server.handleDelete)
	return withCORS(mux)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	response := HealthResponse{
		OK:                true,
		ProtocolVersion:   ProtocolVersion,
		Helper:            HelperName,
		Platform:          string(s.store.Platform()),
		StorageMode:       string(s.store.StorageMode()),
		AvailableRoutes:   AvailableRoutesForStorage(s.store),
		StoredWalletCount: s.store.StoredWalletCount(),
		Warning:           s.store.Warning(),
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	gatewayOrigin := strings.TrimSpace(r.URL.Query().Get("gatewayOrigin"))
	walletID := strings.TrimSpace(r.URL.Query().Get("walletId"))
	if gatewayOrigin == "" || walletID == "" {
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
	var request DeviceShareStoreRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	record := normalizeRecord(StoredShareRecord{
		GatewayOrigin: request.GatewayOrigin,
		WalletID:      request.WalletID,
		DeviceShare:   request.DeviceShare,
		CredentialID:  derefString(request.CredentialID),
		DeviceLabel:   derefString(request.DeviceLabel),
	})
	if record.GatewayOrigin == "" || record.WalletID == "" || record.DeviceShare == "" {
		http.Error(w, "gatewayOrigin, walletId, and deviceShare are required", http.StatusBadRequest)
		return
	}
	if err := s.store.Save(withTimeout(r.Context()), record); err != nil {
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
	var request DeviceShareLoadRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(request.GatewayOrigin) == "" || strings.TrimSpace(request.WalletID) == "" {
		http.Error(w, "gatewayOrigin and walletId are required", http.StatusBadRequest)
		return
	}
	record, err := s.store.Load(
		withTimeout(r.Context()),
		request.GatewayOrigin,
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
	var request DeviceShareDeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(request.GatewayOrigin) == "" || strings.TrimSpace(request.WalletID) == "" {
		http.Error(w, "gatewayOrigin and walletId are required", http.StatusBadRequest)
		return
	}
	removed, err := s.store.Delete(withTimeout(r.Context()), request.GatewayOrigin, request.WalletID)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, DeviceShareDeleteResponse{
		OK:      true,
		Removed: removed,
	})
}

func withTimeout(ctx context.Context) context.Context {
	timeoutCtx, _ := context.WithTimeout(ctx, 30*time.Second)
	return timeoutCtx
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
