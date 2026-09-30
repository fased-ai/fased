package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"reflect"
)

type wenCampaignPolicyV1 struct {
	Window                                           solana.PublicKey
	MaxPrice, Daily, Total, Expiry, MaxWait, Enabled uint64
}

// Bound to the position's current campaign. This changes future instructions,
// never paid totals, reserved capital, custody or historical claims.
func buildWENCampaignPolicyV1(a wenCampaignOwnerActionV1, owner solana.PublicKey, s wenCampaignPositionV1, keys solana.AccountMetaSlice) (solana.Instruction, error) {
	bad := errors.New("invalid campaign future policy")
	q, w := a.Policy, s.PolicyWindow
	if q == nil || w == nil || a.Amount != 0 || w.Owner != a.Program || w.Executable || len(w.Data) != 256 {
		return nil, bad
	}
	b := w.Data
	p := s.Data
	if string(b[:8]) != "WENRCMP2" || b[8] != 1 || b[9] != 0 || !bytes.Equal(b[12:16], make([]byte, 4)) || b[10] > 2 || !(b[11] <= 7 || b[11] >= 12 && b[11] <= 15 || b[11] >= 30 && b[11] <= 31 || b[11] >= 62 && b[11] <= 63) {
		return nil, bad
	}
	window, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-retail-window-v2"), b[16:48], b[48:80], b[112:120]}, a.Program)
	n := func(d []byte, o int) uint64 { return binary.LittleEndian.Uint64(d[o : o+8]) }
	if e != nil || window != q.Window || w.Address != window || !bytes.Equal(p[192:224], window[:]) || !bytes.Equal(p[48:80], b[16:48]) || !bytes.Equal(p[80:112], b[48:80]) || window == owner || window == a.Position || window == a.Program || s.Now == 0 || s.Now > 1<<63-1 || s.Now < n(b, 136) || n(p, 160) != 0 {
		return nil, bad
	}
	if q.MaxPrice == 0 || q.Daily == 0 || q.Total < q.Daily || q.Total < n(p, 152) || n(p, 168) == s.Now/86400 && q.Daily < n(p, 176) || q.Expiry <= s.Now || q.MaxWait == 0 || q.Enabled > 1 {
		return nil, bad
	}
	data := make([]byte, 49)
	data[0] = 160
	for i, v := range []uint64{q.MaxPrice, q.Daily, q.Total, q.Expiry, q.MaxWait, q.Enabled} {
		binary.LittleEndian.PutUint64(data[1+i*8:], v)
	}
	return solana.NewInstruction(a.Program, append(keys, solana.Meta(window)), data), nil
}
func sameWENCampaignPolicyStateV1(a, b wenCampaignPositionV1) bool {
	return reflect.DeepEqual(a.PolicyWindow, b.PolicyWindow)
}
