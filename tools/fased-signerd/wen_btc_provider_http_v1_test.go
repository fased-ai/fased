package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

type wenProviderTransport func(*http.Request) (*http.Response, error)

func (f wenProviderTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestWENBTCProviderHTTP(t *testing.T) {
	for _, name := range []string{"valid", "http-error", "redirect", "network", "oversize", "json", "quote-mint", "setup", "other", "cleanup", "missing-swap", "cancelled", "bad-slippage"} {
		t.Run(name, func(t *testing.T) {
			a, wallet, route, _, _ := wenAcquisitionFixture(t)
			at := 13 + 4*int(binary.LittleEndian.Uint32(route.Data[9:13]))
			out := binary.LittleEndian.Uint64(route.Data[at+8:])
			slip := uint64(binary.LittleEndian.Uint16(route.Data[at+16:]))
			floor := (out/10000)*(10000-slip) + (out%10000)*(10000-slip)/10000
			q := map[string]any{"inputMint": a.keys[3].String(), "outputMint": a.keys[4].String(), "inAmount": strconv.FormatUint(a.numbers[10], 10), "outAmount": strconv.FormatUint(out, 10), "otherAmountThreshold": strconv.FormatUint(floor, 10), "swapMode": "ExactIn", "slippageBps": slip, "contextSlot": 150}
			ix := signerWENBTCProviderInstructionV1{ProgramID: route.Program.String(), Accounts: route.Accounts, Data: base64.StdEncoding.EncodeToString(route.Data)}
			review := signerWENBTCReviewV1{WalletPublicKey: wallet.String(), Pins: signerWENBTCPinsV1{ProgramID: a.program.String(), OfferSHA256: wenHashV1(a.offer[:])}, Intent: signerWENBTCIntentV1{Operation: "acquisition", MinFinalizedSlot: "100", ExpiresSlot: "200"}, MaxSlotLag: 5, RouteValidity: &signerWENBTCRouteValidityV1{ObservedSlot: 150, ExpiresSlot: 156}}
			c, err := newWENBTCProviderHTTPV1("test-key")
			if err != nil {
				t.Fatal(err)
			}
			if c.http.CheckRedirect(&http.Request{}, nil) != http.ErrUseLastResponse {
				t.Fatal("redirect policy")
			}
			calls := 0
			c.http.Transport = wenProviderTransport(func(req *http.Request) (*http.Response, error) {
				calls++
				if req.URL.Scheme != "https" || req.URL.Host != "api.jup.ag" || req.Header.Get("x-api-key") != "test-key" {
					t.Fatal("endpoint/key binding")
				}
				if req.Context().Err() != nil {
					return nil, req.Context().Err()
				}
				if name == "network" {
					return nil, errors.New("test-key must not escape")
				}
				status := 200
				if name == "http-error" {
					status = 429
				}
				if name == "redirect" {
					status = 302
				}
				var raw []byte
				if calls == 1 {
					if req.Method != "GET" || req.URL.Path != "/swap/v1/quote" || req.URL.Query().Get("amount") != q["inAmount"] || req.URL.Query().Get("inputMint") != a.keys[3].String() || req.URL.Query().Get("outputMint") != a.keys[4].String() || req.URL.Query().Get("swapMode") != "ExactIn" || req.URL.Query().Get("slippageBps") != strconv.FormatUint(slip, 10) {
						t.Fatal("quote request changed")
					}
					if name == "quote-mint" {
						q["inputMint"] = "bad"
					}
					raw, _ = json.Marshal(q)
				} else {
					if calls != 2 || req.Method != "POST" || req.URL.Path != "/swap/v1/swap-instructions" {
						t.Fatal("extra request")
					}
					body, _ := io.ReadAll(req.Body)
					var data map[string]any
					json.Unmarshal(body, &data)
					if data["userPublicKey"] != route.Accounts[2].Pubkey || data["destinationTokenAccount"] != route.Accounts[6].Pubkey || data["payer"] != wallet.String() || data["useSharedAccounts"] != true || data["wrapAndUnwrapSol"] != false || data["dynamicSlippage"] != false {
						t.Fatal("custody request changed")
					}
					response := map[string]any{"swapInstruction": ix}
					switch name {
					case "setup":
						response["setupInstructions"] = []any{ix}
					case "other":
						response["otherInstructions"] = []any{ix}
					case "cleanup":
						response["cleanupInstruction"] = ix
					case "missing-swap":
						delete(response, "swapInstruction")
					}
					raw, _ = json.Marshal(response)
				}
				if name == "oversize" {
					raw = []byte(strings.Repeat("x", 65537))
				}
				if name == "json" {
					raw = []byte("bad")
				}
				return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if name == "cancelled" {
				cancel()
			}
			if name == "bad-slippage" {
				slip = 51
			}
			candidate, err := c.candidate(ctx, a, wallet, review, 154, a.numbers[14], slip)
			if name == "valid" {
				if err != nil || candidate == nil || calls != 2 {
					t.Fatalf("candidate failed: %v", err)
				}
			} else {
				if err == nil || candidate != nil {
					t.Fatal("invalid provider admitted")
				}
				if strings.Contains(err.Error(), "test-key") {
					t.Fatal("credential leaked")
				}
			}
			if name == "quote-mint" && calls != 1 {
				t.Fatal("invalid quote forwarded")
			}
		})
	}
}
func TestWENBTCProviderCredential(t *testing.T) {
	for _, key := range []string{"", " secret", "secret\n", strings.Repeat("a", 4097)} {
		if c, err := newWENBTCProviderHTTPV1(key); err == nil || c != nil {
			t.Fatal("invalid key accepted")
		}
	}
}
