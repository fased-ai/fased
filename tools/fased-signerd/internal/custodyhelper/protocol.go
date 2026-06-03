package custodyhelper

const (
	ProtocolVersion = 1
	Host            = "127.0.0.1"
	Port            = 18795
	HelperName      = "fased-native-custody-helper"

	HealthPath            = "/v1/custody/health"
	DeviceShareStatusPath = "/v1/custody/device-share/status"
	DeviceShareStorePath  = "/v1/custody/device-share/store"
	DeviceShareLoadPath   = "/v1/custody/device-share/load"
	DeviceShareDeletePath = "/v1/custody/device-share/delete"
)

var StorageRoutes = []string{
	DeviceShareStatusPath,
	DeviceShareStorePath,
	DeviceShareLoadPath,
	DeviceShareDeletePath,
}

type HealthResponse struct {
	OK                bool     `json:"ok"`
	ProtocolVersion   int      `json:"protocolVersion"`
	Helper            string   `json:"helper"`
	Platform          string   `json:"platform"`
	StorageMode       string   `json:"storageMode"`
	AvailableRoutes   []string `json:"availableRoutes"`
	StoredWalletCount int      `json:"storedWalletCount"`
	Warning           string   `json:"warning,omitempty"`
}

type DeviceShareStatusResponse struct {
	OK     bool `json:"ok"`
	Stored bool `json:"stored"`
}

type DeviceShareStoreRequest struct {
	GatewayOrigin string  `json:"gatewayOrigin"`
	WalletID      string  `json:"walletId"`
	DeviceShare   string  `json:"deviceShare"`
	CredentialID  *string `json:"credentialId,omitempty"`
	DeviceLabel   *string `json:"deviceLabel,omitempty"`
}

type DeviceShareStoreResponse struct {
	OK          bool   `json:"ok"`
	Stored      bool   `json:"stored"`
	StorageMode string `json:"storageMode"`
}

type DeviceShareLoadRequest struct {
	GatewayOrigin string  `json:"gatewayOrigin"`
	WalletID      string  `json:"walletId"`
	Prompt        *string `json:"prompt,omitempty"`
}

type DeviceShareLoadResponse struct {
	OK          bool   `json:"ok"`
	DeviceShare string `json:"deviceShare"`
}

type DeviceShareDeleteRequest struct {
	GatewayOrigin string `json:"gatewayOrigin"`
	WalletID      string `json:"walletId"`
}

type DeviceShareDeleteResponse struct {
	OK      bool `json:"ok"`
	Removed bool `json:"removed"`
}
