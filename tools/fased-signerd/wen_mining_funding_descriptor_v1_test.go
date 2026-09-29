package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func fundingDescriptorFixture(t *testing.T) ([]byte, wenStakingPinsV1) {
	t.Helper()
	v, _, _ := miningFundingFixture(t)
	program := solana.MustPublicKeyFromBase58(v.ProgramID)
	p := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, CodeSHA256: wenHashV1([]byte("funding code")), DeploymentSlot: 5}
	cwd, _ := os.Getwd()
	root := filepath.Clean(filepath.Join(cwd, "../../.."))
	script := `import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';const root=process.argv[1],x=JSON.parse(readFileSync(0,'utf8'));const {miningFundingDescriptor}=await import(pathToFileURL(root+'/token/sat/wen-genesis/tests/support/portfolio-descriptor.mjs'));const vector=JSON.parse(readFileSync(root+'/fased/tools/fased-signerd/testdata/wen-mining-funding-candidate.json')).instruction;const {binding:b}=await miningFundingDescriptor(vector,{program:x.program,deployedBytesHash:x.code,deploymentSlot:5n,upgradeAuthority:null},x.genesis);console.log(JSON.stringify({raw:Buffer.from(b.bytes).toString('base64'),sha:b.sha256,cap:b.portfolioMiningFundingCapabilityDigest}));`
	input, _ := json.Marshal(map[string]string{"program": hex.EncodeToString(program[:]), "code": p.CodeSHA256, "genesis": p.Genesis})
	cmd := exec.Command("node", "--input-type=module", "-e", script, root)
	cmd.Stdin = bytes.NewReader(input)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("%v %s", e, out)
	}
	var fixture struct{ Raw, Sha, Cap string }
	if e = json.Unmarshal(out, &fixture); e != nil {
		t.Fatal(e)
	}
	raw, e := base64.StdEncoding.DecodeString(fixture.Raw)
	if e != nil {
		t.Fatal(e)
	}
	p.DescriptorSHA256 = fixture.Sha
	p.CapabilitySHA256 = fixture.Cap
	if e = validateWENMiningFundingDescriptorV1(raw, p); e != nil {
		t.Fatal(e)
	}
	return raw, p
}

func TestWENMiningFundingDescriptorPortableParity(t *testing.T) {
	raw, p := fundingDescriptorFixture(t)
	program := solana.MustPublicKeyFromBase58(p.ProgramID)
	cases := []struct {
		path  []string
		value any
	}{
		{[]string{"build", "candidateFeatures", "portfolio-vault-candidate"}, false},
		{[]string{"interfaces", "portfolioMiningFundingHandoff", "instruction", "opcode"}, 117},
		{[]string{"interfaces", "portfolioMiningFundingHandoff", "instruction", "dataLength"}, 2},
		{[]string{"interfaces", "portfolioMiningFundingHandoff", "operations"}, []string{"reserve"}},
		{[]string{"interfaces", "portfolioMiningFundingHandoff", "extra"}, true},
		{[]string{"interfaces", "portfolioMiningFundingHandoff", "sourceDigest"}, wenHashV1([]byte("wrong"))},
		{[]string{"runtimeCompatibility", "portfolioMiningFundingCapability"}, "wrong"},
		{[]string{"deployment", "portfolioMiningFunding", "genesis"}, "wrong"},
		{[]string{"deployment", "portfolioMiningFunding", "upgradeAuthority"}, hex.EncodeToString(program[:])},
		{[]string{"deployment", "portfolioMiningFunding", "deploymentSlot"}, "6"},
		{[]string{"deployment", "portfolioMiningFunding", "deployedBytesHash"}, wenHashV1([]byte("wrong"))},
		{[]string{"runtimeCompatibility", "status"}, "NOT_BOUND"},
	}
	for _, c := range cases {
		var d map[string]any
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		decoder.Decode(&d)
		target := d
		for _, key := range c.path[:len(c.path)-1] {
			target = target[key].(map[string]any)
		}
		target[c.path[len(c.path)-1]] = c.value
		delete(d, "descriptorDigest")
		body, _ := wenJSONV1(d)
		d["descriptorDigest"] = "sha256:" + wenHashV1(body)
		changed, _ := wenJSONV1(d)
		pins := p
		pins.DescriptorSHA256 = wenHashV1(changed)
		if validateWENMiningFundingDescriptorV1(changed, pins) == nil {
			t.Fatalf("mutation admitted: %v", c.path)
		}
	}
	bad := p
	bad.CapabilitySHA256 = wenHashV1([]byte("other"))
	if validateWENMiningFundingDescriptorV1(raw, bad) == nil {
		t.Fatal("independent capability pin")
	}
	bad = p
	bad.DescriptorSHA256 = wenHashV1([]byte("other"))
	if validateWENMiningFundingDescriptorV1(raw, bad) == nil {
		t.Fatal("independent descriptor pin")
	}
}
