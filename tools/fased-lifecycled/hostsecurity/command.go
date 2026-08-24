package hostsecurity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"regexp"
	"syscall"
)

const maxCommandOutput = 1 << 20

type Runner interface {
	Run(context.Context, string, []string, io.Reader, io.Writer, io.Writer, []string) error
	Output(context.Context, string, ...string) ([]byte, error)
}

type CommandRunner struct{}

func (CommandRunner) Run(ctx context.Context, command string, args []string, stdin io.Reader, stdout, stderr io.Writer, environment []string) error {
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	cmd.Env = append([]string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}, environment...)
	return cmd.Run()
}

func (runner CommandRunner) Output(ctx context.Context, command string, args ...string) ([]byte, error) {
	var output bytes.Buffer
	limited := &boundedWriter{Writer: &output, Remaining: maxCommandOutput}
	err := runner.Run(ctx, command, args, nil, limited, limited, nil)
	if limited.Exceeded {
		return nil, errors.New("Hosting security command output exceeded its bound")
	}
	return output.Bytes(), err
}

type boundedWriter struct {
	Writer    io.Writer
	Remaining int
	Exceeded  bool
}

func (writer *boundedWriter) Write(data []byte) (int, error) {
	if len(data) > writer.Remaining {
		writer.Exceeded = true
		return 0, errors.New("bounded writer exceeded")
	}
	written, err := writer.Writer.Write(data)
	writer.Remaining -= written
	return written, err
}

func fixedExecutable(candidates ...string) (string, error) {
	for _, candidate := range candidates {
		info, err := os.Lstat(candidate)
		stat, statOK := infoSyscallStat(info)
		if err == nil && statOK && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 &&
			info.Mode().Perm()&0o111 != 0 && info.Mode().Perm()&0o022 == 0 && stat.Uid == 0 && stat.Nlink >= 1 {
			return candidate, nil
		}
	}
	return "", errors.New("required fixed root-owned system executable is unavailable")
}

func infoSyscallStat(info os.FileInfo) (*syscall.Stat_t, bool) {
	if info == nil {
		return nil, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return stat, ok
}

// CommandSchemaVersion is the stable bootstrap-to-lifecycle-host Hosting
// security protocol. The bootstrap coordinates this small fixed envelope; all
// evolving host policy and durable-state decoding stay inside the acquired,
// attested lifecycle host.
const CommandSchemaVersion uint32 = 1

type CommandOperation string

const (
	CommandPrepare            CommandOperation = "PREPARE"
	CommandBindRuntimeReady   CommandOperation = "BIND_RUNTIME_READY"
	CommandCompleteOnboarding CommandOperation = "COMPLETE_ONBOARDING"
	CommandCommit             CommandOperation = "COMMIT"
	CommandAbort              CommandOperation = "ABORT"
)

type CommandRequest struct {
	SchemaVersion            uint32           `json:"schemaVersion"`
	Operation                CommandOperation `json:"operation"`
	TransactionID            string           `json:"transactionId,omitempty"`
	Release                  string           `json:"release,omitempty"`
	Channel                  string           `json:"updateChannel,omitempty"`
	GatewayPort              uint16           `json:"gatewayPort,omitempty"`
	OperatorUser             string           `json:"operatorUser,omitempty"`
	PlatformIdentity         string           `json:"platformIdentity,omitempty"`
	TrustRootSHA256          string           `json:"trustRootSha256,omitempty"`
	AuthKeyFile              string           `json:"authKeyFile,omitempty"`
	Interactive              bool             `json:"interactive,omitempty"`
	OnboardingRequired       bool             `json:"onboardingRequired,omitempty"`
	RequireExistingHardening bool             `json:"requireExistingHardening,omitempty"`
	GenerationID             string           `json:"generationId,omitempty"`
	ConvergenceReceiptDigest string           `json:"convergenceReceiptDigest,omitempty"`
	AccessConfirmed          bool             `json:"accessConfirmed,omitempty"`
}

// CommandState is deliberately a projection, not the durable State schema.
// Its fields are the fixed orchestration facts an older bootstrap may consume
// from a newer lifecycle host. New hosts may add response fields without
// requiring the bootstrap to decode their internal durable state.
type CommandState struct {
	SchemaVersion uint32 `json:"schemaVersion"`
	// TransactionID correlates this response to the invoking command. The
	// lifecycle host may resume an older durable transaction during PREPARE;
	// DurableTransactionID identifies that transaction for later transitions.
	TransactionID            string `json:"transactionId"`
	DurableTransactionID     string `json:"durableTransactionId,omitempty"`
	Release                  string `json:"release"`
	OperatorUser             string `json:"operatorUser"`
	TailscaleDNS             string `json:"tailscaleDns,omitempty"`
	LifecycleGenerationID    string `json:"lifecycleGenerationId,omitempty"`
	ConvergenceReceiptDigest string `json:"convergenceReceiptDigest,omitempty"`
	RuntimeReady             bool   `json:"runtimeReady,omitempty"`
	OnboardingRequired       bool   `json:"onboardingRequired,omitempty"`
	OnboardingComplete       bool   `json:"onboardingComplete,omitempty"`
	OnboardingPending        bool   `json:"onboardingPending,omitempty"`
	NeedsFinalization        bool   `json:"needsFinalization,omitempty"`
	Committed                bool   `json:"committed,omitempty"`
}

var commandDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func DecodeCommandRequest(reader io.Reader) (CommandRequest, error) {
	decoder := json.NewDecoder(io.LimitReader(reader, 64<<10))
	decoder.DisallowUnknownFields()
	var request CommandRequest
	if err := decoder.Decode(&request); err != nil {
		return CommandRequest{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return CommandRequest{}, errors.New("Hosting security command contains trailing data")
		}
		return CommandRequest{}, err
	}
	if err := request.Validate(); err != nil {
		return CommandRequest{}, err
	}
	return request, nil
}

func (request CommandRequest) Validate() error {
	if request.SchemaVersion != CommandSchemaVersion {
		return errors.New("unsupported Hosting security command schema")
	}
	switch request.Operation {
	case CommandPrepare:
		prepare := Request{
			TransactionID: request.TransactionID, Release: request.Release, Channel: request.Channel,
			GatewayPort: request.GatewayPort, OperatorUser: request.OperatorUser,
			PlatformIdentity: request.PlatformIdentity, TrustRootSHA256: request.TrustRootSHA256,
			AuthKeyFile: request.AuthKeyFile, Interactive: request.Interactive,
			OnboardingRequired: request.OnboardingRequired, RequireExistingHardening: request.RequireExistingHardening,
		}
		if err := prepare.Validate(); err != nil {
			return err
		}
		if request.GenerationID != "" || request.ConvergenceReceiptDigest != "" || request.AccessConfirmed {
			return errors.New("Hosting security prepare contains transition-only fields")
		}
	case CommandBindRuntimeReady:
		if !uuidV4Pattern.MatchString(request.TransactionID) || !commandDigestPattern.MatchString(request.GenerationID) ||
			!commandDigestPattern.MatchString(request.ConvergenceReceiptDigest) {
			return errors.New("Hosting runtime binding command is invalid")
		}
	case CommandCompleteOnboarding, CommandAbort:
		if !uuidV4Pattern.MatchString(request.TransactionID) {
			return errors.New("Hosting security transition identity is invalid")
		}
	case CommandCommit:
		if !uuidV4Pattern.MatchString(request.TransactionID) {
			return errors.New("Hosting security commit identity is invalid")
		}
	default:
		return errors.New("unsupported Hosting security command operation")
	}
	return nil
}

func ExecuteCommand(ctx context.Context, participant Participant, request CommandRequest) (CommandState, error) {
	if err := request.Validate(); err != nil {
		return CommandState{}, err
	}
	var state State
	var err error
	switch request.Operation {
	case CommandPrepare:
		state, err = participant.Prepare(ctx, Request{
			TransactionID: request.TransactionID, Release: request.Release, Channel: request.Channel,
			GatewayPort: request.GatewayPort, OperatorUser: request.OperatorUser,
			PlatformIdentity: request.PlatformIdentity, TrustRootSHA256: request.TrustRootSHA256,
			AuthKeyFile: request.AuthKeyFile, Interactive: request.Interactive,
			OnboardingRequired: request.OnboardingRequired, RequireExistingHardening: request.RequireExistingHardening,
		})
	case CommandBindRuntimeReady:
		state, err = participant.BindRuntimeReady(ctx, request.TransactionID, request.GenerationID, request.ConvergenceReceiptDigest, request.OnboardingRequired)
	case CommandCompleteOnboarding:
		state, err = participant.MarkOnboardingComplete(request.TransactionID)
	case CommandCommit:
		state, err = participant.Commit(ctx, request.TransactionID, request.AccessConfirmed)
	case CommandAbort:
		err = participant.Abort(ctx, request.TransactionID)
		if err == nil {
			state, err = participant.Store.ReadState()
		}
	}
	if err != nil {
		return CommandState{}, err
	}
	return projectCommandState(request.TransactionID, state), nil
}

func projectCommandState(requestTransactionID string, state State) CommandState {
	return CommandState{
		SchemaVersion: CommandSchemaVersion, TransactionID: requestTransactionID, DurableTransactionID: state.TransactionID, Release: state.Release,
		OperatorUser: state.OperatorUser, TailscaleDNS: state.TailscaleDNS,
		LifecycleGenerationID: state.LifecycleGenerationID, ConvergenceReceiptDigest: state.ConvergenceReceiptDigest,
		RuntimeReady: state.RuntimeReady, OnboardingRequired: state.OnboardingRequired,
		OnboardingComplete: state.OnboardingComplete, OnboardingPending: state.Phase == PhaseOnboardingPending,
		NeedsFinalization: state.Phase != PhaseCommitted, Committed: state.Phase == PhaseCommitted,
	}
}

// DurableTransactionIDFor validates the command-response correlation and
// returns the lifecycle-host-owned identity used for later transitions. A
// response without durableTransactionId is the compatibility projection from
// an older lifecycle host: only PREPARE may return a different, already-durable
// transaction, and it must still bind the exact release and operator.
func (state CommandState) DurableTransactionIDFor(request CommandRequest) (string, error) {
	if state.SchemaVersion != CommandSchemaVersion || state.OperatorUser == "" {
		return "", errors.New("Hosting security response identity is invalid")
	}
	if request.Operation == CommandPrepare && (state.Release != request.Release || state.OperatorUser != request.OperatorUser) {
		return "", errors.New("Hosting security prepare response identity is invalid")
	}
	durable := state.DurableTransactionID
	if durable == "" {
		durable = state.TransactionID
		if request.Operation != CommandPrepare && state.TransactionID != request.TransactionID {
			return "", errors.New("Hosting security legacy response correlation is invalid")
		}
	} else if state.TransactionID != request.TransactionID {
		return "", errors.New("Hosting security response correlation is invalid")
	}
	if !uuidV4Pattern.MatchString(durable) {
		return "", errors.New("Hosting security durable transaction identity is invalid")
	}
	return durable, nil
}
