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

const principalCommandOutputLimit = 64 << 10

type LinuxPrincipalSystem struct {
	commands map[string]string
}

func NewLinuxPrincipalSystem() (*LinuxPrincipalSystem, error) {
	candidates := map[string][]string{
		"getent":   {"/usr/bin/getent", "/bin/getent"},
		"groupadd": {"/usr/sbin/groupadd", "/sbin/groupadd"},
		"useradd":  {"/usr/sbin/useradd", "/sbin/useradd"},
		"userdel":  {"/usr/sbin/userdel", "/sbin/userdel"},
		"groupdel": {"/usr/sbin/groupdel", "/sbin/groupdel"},
		"usermod":  {"/usr/sbin/usermod", "/sbin/usermod"},
		"gpasswd":  {"/usr/bin/gpasswd", "/bin/gpasswd"},
		"passwd":   {"/usr/bin/passwd", "/bin/passwd"},
		"id":       {"/usr/bin/id", "/bin/id"},
	}
	commands := map[string]string{}
	for name, paths := range candidates {
		for _, path := range paths {
			info, err := os.Lstat(path)
			if err != nil {
				continue
			}
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || info.Mode().Perm()&0o111 == 0 || !ok || stat.Uid != 0 {
				return nil, fmt.Errorf("principal command %s is unsafe", path)
			}
			commands[name] = path
			break
		}
		if commands[name] == "" {
			return nil, fmt.Errorf("required principal command %s is unavailable", name)
		}
	}
	return &LinuxPrincipalSystem{commands: commands}, nil
}

func (system *LinuxPrincipalSystem) output(ctx context.Context, name string, arguments ...string) ([]byte, error) {
	path := system.commands[name]
	if path == "" {
		return nil, errors.New("principal command is not configured")
	}
	command := exec.CommandContext(ctx, path, arguments...)
	command.Env = []string{"HOME=/root", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
	data, err := command.CombinedOutput()
	if len(data) > principalCommandOutputLimit {
		return nil, errors.New("principal command output exceeds limit")
	}
	if err != nil {
		return data, fmt.Errorf("%s failed: %w: %s", name, err, strings.TrimSpace(string(data)))
	}
	return data, nil
}

func missingGetent(err error) bool {
	var exit *exec.ExitError
	return errors.As(err, &exit) && exit.ExitCode() == 2
}

func parsePositiveID(raw, label string) (uint32, error) {
	value, err := strconv.ParseUint(raw, 10, 32)
	if err != nil || value == 0 {
		return 0, fmt.Errorf("%s is invalid", label)
	}
	return uint32(value), nil
}

func (system *LinuxPrincipalSystem) LookupUser(ctx context.Context, name string) (AccountRecord, bool, error) {
	data, err := system.output(ctx, "getent", "passwd", name)
	if err != nil {
		if missingGetent(err) {
			return AccountRecord{}, false, nil
		}
		return AccountRecord{}, false, err
	}
	fields := strings.Split(strings.TrimSpace(string(data)), ":")
	if len(fields) != 7 || fields[0] != name {
		return AccountRecord{}, false, errors.New("passwd identity record is malformed")
	}
	uid, err := parsePositiveID(fields[2], "account UID")
	if err != nil {
		return AccountRecord{}, false, err
	}
	gid, err := parsePositiveID(fields[3], "account GID")
	if err != nil {
		return AccountRecord{}, false, err
	}
	return AccountRecord{Name: fields[0], UID: uid, GID: gid, Home: fields[5], Shell: fields[6]}, true, nil
}

func (system *LinuxPrincipalSystem) LookupGroup(ctx context.Context, name string) (GroupRecord, bool, error) {
	data, err := system.output(ctx, "getent", "group", name)
	if err != nil {
		if missingGetent(err) {
			return GroupRecord{}, false, nil
		}
		return GroupRecord{}, false, err
	}
	fields := strings.Split(strings.TrimSpace(string(data)), ":")
	if len(fields) != 4 || fields[0] != name {
		return GroupRecord{}, false, errors.New("group identity record is malformed")
	}
	gid, err := parsePositiveID(fields[2], "group GID")
	if err != nil {
		return GroupRecord{}, false, err
	}
	return GroupRecord{Name: fields[0], GID: gid}, true, nil
}

func (system *LinuxPrincipalSystem) AddGroup(ctx context.Context, name string) error {
	_, err := system.output(ctx, "groupadd", "--system", name)
	return err
}

func (system *LinuxPrincipalSystem) AddUser(ctx context.Context, request AddUserRequest) error {
	arguments := []string{}
	if request.System {
		arguments = append(arguments, "--system")
	}
	if request.CreateHome {
		arguments = append(arguments, "--create-home", "--user-group")
	} else {
		arguments = append(arguments, "--no-create-home")
	}
	if request.PrimaryGroup != "" {
		arguments = append(arguments, "--gid", request.PrimaryGroup)
	}
	arguments = append(arguments, "--home-dir", request.Home, "--shell", request.Shell, request.Name)
	_, err := system.output(ctx, "useradd", arguments...)
	return err
}

func (system *LinuxPrincipalSystem) AddMemberships(ctx context.Context, user string, groups []string) error {
	if len(groups) == 0 {
		return nil
	}
	_, err := system.output(ctx, "usermod", "--append", "--groups", strings.Join(groups, ","), user)
	return err
}

func (system *LinuxPrincipalSystem) memberships(ctx context.Context, user string) (map[string]bool, error) {
	data, err := system.output(ctx, "id", "-nG", user)
	if err != nil {
		return nil, err
	}
	result := map[string]bool{}
	for _, group := range strings.Fields(string(data)) {
		result[group] = true
	}
	return result, nil
}

func (system *LinuxPrincipalSystem) Memberships(ctx context.Context, user string) (map[string]bool, error) {
	return system.memberships(ctx, user)
}

func (system *LinuxPrincipalSystem) DeleteUser(ctx context.Context, user string) error {
	_, err := system.output(ctx, "userdel", user)
	return err
}

func (system *LinuxPrincipalSystem) DeleteGroup(ctx context.Context, group string) error {
	_, err := system.output(ctx, "groupdel", group)
	return err
}

func (system *LinuxPrincipalSystem) RemoveMembership(ctx context.Context, user, group string) error {
	memberships, err := system.memberships(ctx, user)
	if err != nil || !memberships[group] {
		return err
	}
	_, err = system.output(ctx, "gpasswd", "--delete", user, group)
	return err
}

func (system *LinuxPrincipalSystem) LockUser(ctx context.Context, user string) error {
	_, err := system.output(ctx, "passwd", "--lock", user)
	return err
}
