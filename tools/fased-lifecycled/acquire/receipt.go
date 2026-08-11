package acquire

type Receipt struct {
	SchemaVersion uint32 `json:"schemaVersion"`
	Asset         string `json:"asset"`
	SHA256        string `json:"sha256"`
	Size          uint64 `json:"size"`
	RelativePath  string `json:"relativePath"`
	Device        uint64 `json:"device"`
	Inode         uint64 `json:"inode"`
}
