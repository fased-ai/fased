package main

// Typed accounts are shared by Agent Capital and WEN financial instructions.
type signerTypedAccountV2 struct {
	Pubkey     string `json:"pubkey"`
	IsSigner   bool   `json:"isSigner"`
	IsWritable bool   `json:"isWritable"`
}
