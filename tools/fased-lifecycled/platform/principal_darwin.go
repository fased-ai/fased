//go:build darwin

package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

type DarwinPrincipalSystem struct {
	commands map[string]string
}

func NewDarwinPrincipalSystem() (*DarwinPrincipalSystem, error) {
	commands := map[string]string{"dscl": "/usr/bin/dscl", "dseditgroup": "/usr/sbin/dseditgroup", "id": "/usr/bin/id"}
	for name, path := range commands {
		info, err := os.Lstat(path)
		stat, ok := infoSysStat(info)
		if err != nil || !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || info.Mode().Perm()&0o111 == 0 || stat.Uid != 0 {
			return nil, fmt.Errorf("required Darwin principal command %s is unavailable or unsafe", name)
		}
	}
	return &DarwinPrincipalSystem{commands: commands}, nil
}

func infoSysStat(info os.FileInfo) (*syscall.Stat_t, bool) {
	if info == nil {
		return nil, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return stat, ok
}

func (system *DarwinPrincipalSystem) output(ctx context.Context, name string, arguments ...string) ([]byte, error) {
	command := system.commands[name]
	if command == "" {
		return nil, errors.New("Darwin principal command is not configured")
	}
	process := exec.CommandContext(ctx, command, arguments...)
	process.Env = []string{"HOME=/var/root", "LANG=C", "LC_ALL=C", "PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
	output, err := process.CombinedOutput()
	if len(output) > principalCommandOutputLimit {
		return nil, errors.New("Darwin principal command output exceeds limit")
	}
	if err != nil {
		return output, fmt.Errorf("%s failed: %w: %s", name, err, strings.TrimSpace(string(output)))
	}
	return output, nil
}

func darwinRecordMissing(data []byte, err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(string(data) + " " + err.Error())
	return strings.Contains(text, "edsrecordnotfound") || strings.Contains(text, "record was not found") || strings.Contains(text, "no such key")
}

func parseDarwinAttributes(data []byte) map[string]string {
	attributes := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			attributes[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return attributes
}

func (system *DarwinPrincipalSystem) LookupUser(ctx context.Context, name string) (AccountRecord, bool, error) {
	data, err := system.output(ctx, "dscl", ".", "-read", "/Users/"+name, "RecordName", "UniqueID", "PrimaryGroupID", "NFSHomeDirectory", "UserShell")
	if darwinRecordMissing(data, err) {
		return AccountRecord{}, false, nil
	}
	if err != nil {
		return AccountRecord{}, false, err
	}
	attributes := parseDarwinAttributes(data)
	uid, uidErr := parsePositiveID(attributes["UniqueID"], "account UID")
	gid, gidErr := parsePositiveID(attributes["PrimaryGroupID"], "account GID")
	recordNames := strings.Fields(attributes["RecordName"])
	if uidErr != nil || gidErr != nil || len(recordNames) != 1 || recordNames[0] != name {
		return AccountRecord{}, false, errors.New("Darwin account record is malformed")
	}
	return AccountRecord{Name: name, UID: uid, GID: gid, Home: attributes["NFSHomeDirectory"], Shell: attributes["UserShell"]}, true, nil
}

func (system *DarwinPrincipalSystem) LookupGroup(ctx context.Context, name string) (GroupRecord, bool, error) {
	data, err := system.output(ctx, "dscl", ".", "-read", "/Groups/"+name, "RecordName", "PrimaryGroupID")
	if darwinRecordMissing(data, err) {
		return GroupRecord{}, false, nil
	}
	if err != nil {
		return GroupRecord{}, false, err
	}
	attributes := parseDarwinAttributes(data)
	gid, gidErr := parsePositiveID(attributes["PrimaryGroupID"], "group GID")
	if gidErr != nil || len(strings.Fields(attributes["RecordName"])) == 0 || strings.Fields(attributes["RecordName"])[0] != name {
		return GroupRecord{}, false, errors.New("Darwin group record is malformed")
	}
	return GroupRecord{Name: name, GID: gid}, true, nil
}

func (system *DarwinPrincipalSystem) nextID(ctx context.Context, record string) (uint32, error) {
	data, err := system.output(ctx, "dscl", ".", "-list", record, "UniqueID")
	if record == "/Groups" {
		data, err = system.output(ctx, "dscl", ".", "-list", record, "PrimaryGroupID")
	}
	if err != nil {
		return 0, err
	}
	used := make(map[uint64]bool)
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 {
			value, parseErr := strconv.ParseUint(fields[1], 10, 32)
			if parseErr == nil {
				used[value] = true
			}
		}
	}
	for value := uint64(350); value <= 499; value++ {
		if !used[value] {
			return uint32(value), nil
		}
	}
	return 0, errors.New("Darwin system identity range is exhausted")
}

func (system *DarwinPrincipalSystem) AddGroup(ctx context.Context, name string) error {
	gid, err := system.nextID(ctx, "/Groups")
	if err != nil {
		return err
	}
	if _, err := system.output(ctx, "dscl", ".", "-create", "/Groups/"+name); err != nil {
		return err
	}
	_, err = system.output(ctx, "dscl", ".", "-create", "/Groups/"+name, "PrimaryGroupID", strconv.FormatUint(uint64(gid), 10))
	return err
}

func (system *DarwinPrincipalSystem) AddUser(ctx context.Context, request AddUserRequest) error {
	if request.CreateHome {
		return errors.New("Darwin lifecycle does not create interactive operator accounts")
	}
	group, exists, err := system.LookupGroup(ctx, request.PrimaryGroup)
	if err != nil || !exists {
		return errors.Join(err, errors.New("Darwin service primary group is unavailable"))
	}
	uid, err := system.nextID(ctx, "/Users")
	if err != nil {
		return err
	}
	record := "/Users/" + request.Name
	for _, fields := range [][]string{
		{".", "-create", record}, {".", "-create", record, "UniqueID", strconv.FormatUint(uint64(uid), 10)},
		{".", "-create", record, "PrimaryGroupID", strconv.FormatUint(uint64(group.GID), 10)}, {".", "-create", record, "NFSHomeDirectory", request.Home},
		{".", "-create", record, "UserShell", request.Shell}, {".", "-create", record, "IsHidden", "1"}, {".", "-create", record, "Password", "*"},
	} {
		if _, err := system.output(ctx, "dscl", fields...); err != nil {
			return err
		}
	}
	return nil
}

func (system *DarwinPrincipalSystem) AddMemberships(ctx context.Context, user string, groups []string) error {
	for _, group := range groups {
		if _, err := system.output(ctx, "dseditgroup", "-o", "edit", "-a", user, "-t", "user", group); err != nil {
			return err
		}
	}
	return nil
}

func (system *DarwinPrincipalSystem) Memberships(ctx context.Context, user string) (map[string]bool, error) {
	data, err := system.output(ctx, "id", "-Gn", user)
	if err != nil {
		return nil, err
	}
	groups := make(map[string]bool)
	for _, group := range strings.Fields(string(data)) {
		groups[group] = true
	}
	return groups, nil
}

func (system *DarwinPrincipalSystem) RemoveMembership(ctx context.Context, user, group string) error {
	memberships, err := system.Memberships(ctx, user)
	if err != nil || !memberships[group] {
		return err
	}
	_, err = system.output(ctx, "dseditgroup", "-o", "edit", "-d", user, "-t", "user", group)
	return err
}

func (system *DarwinPrincipalSystem) DeleteUser(ctx context.Context, user string) error {
	_, err := system.output(ctx, "dscl", ".", "-delete", "/Users/"+user)
	return err
}

func (system *DarwinPrincipalSystem) DeleteGroup(ctx context.Context, group string) error {
	_, err := system.output(ctx, "dscl", ".", "-delete", "/Groups/"+group)
	return err
}

func (system *DarwinPrincipalSystem) LockUser(ctx context.Context, user string) error {
	_, err := system.output(ctx, "dscl", ".", "-create", "/Users/"+user, "Password", "*")
	return err
}
