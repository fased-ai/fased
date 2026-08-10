package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"fased-lifecycled/model"
)

var accountNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]{0,30}$`)

type AccountRecord struct {
	Name  string
	UID   uint32
	GID   uint32
	Home  string
	Shell string
}

type GroupRecord struct {
	Name string
	GID  uint32
}

type AddUserRequest struct {
	Name, PrimaryGroup, Home, Shell string
	System, CreateHome              bool
}

type PrincipalSystem interface {
	LookupUser(context.Context, string) (AccountRecord, bool, error)
	LookupGroup(context.Context, string) (GroupRecord, bool, error)
	AddGroup(context.Context, string) error
	AddUser(context.Context, AddUserRequest) error
	AddMemberships(context.Context, string, []string) error
	RemoveMembership(context.Context, string, string) error
	Memberships(context.Context, string) (map[string]bool, error)
	DeleteUser(context.Context, string) error
	DeleteGroup(context.Context, string) error
	LockUser(context.Context, string) error
}

type BootstrapRequest struct {
	Profile        model.Profile
	InstanceID     string
	OperatorUser   string
	OwnerStateRoot string
}

type PrincipalNames struct {
	OperatorUser, GatewayUser, SignerUser                 string
	GatewayGroup, SignerGroup, OperatorGroup, ConfigGroup string
}

type BootstrapGroups struct {
	Gateway, Signer, Operator, Config GroupRecord
}

type BootstrapPrincipals struct {
	Names                     PrincipalNames
	Operator, Gateway, Signer Principal
	Groups                    BootstrapGroups
}

type BootstrapPath struct {
	Path string
	UID  uint32
	GID  uint32
	Mode os.FileMode
}

func BootstrapPrincipalNames(profile model.Profile, instanceID, operatorUser string) (PrincipalNames, error) {
	if !instancePattern.MatchString(instanceID) || !accountNamePattern.MatchString(operatorUser) || operatorUser == "root" {
		return PrincipalNames{}, errors.New("bootstrap account or instance identity is invalid")
	}
	names := PrincipalNames{OperatorUser: operatorUser}
	switch profile {
	case model.ProfileProtectedLocal:
		names.GatewayUser = "fsgw-" + instanceID
		names.SignerUser = "fssg-" + instanceID
		names.GatewayGroup = names.GatewayUser
		names.SignerGroup = names.SignerUser
		names.OperatorGroup = "fsop-" + instanceID
		names.ConfigGroup = "fscf-" + instanceID
	case model.ProfileHosting:
		names.GatewayUser = "fased-gateway"
		names.SignerUser = "fased-signer"
		names.GatewayGroup = "fased-gateway"
		names.SignerGroup = "fased-signer"
		names.OperatorGroup = "fased-operator"
		names.ConfigGroup = "fased-config"
	default:
		return PrincipalNames{}, errors.New("bootstrap profile is unsupported")
	}
	for _, name := range []string{names.GatewayUser, names.SignerUser, names.GatewayGroup, names.SignerGroup, names.OperatorGroup, names.ConfigGroup} {
		if !accountNamePattern.MatchString(name) {
			return PrincipalNames{}, errors.New("derived bootstrap account identity is unsupported")
		}
	}
	return names, nil
}

func ProvisionBootstrapPrincipals(ctx context.Context, system PrincipalSystem, request BootstrapRequest) (BootstrapPrincipals, error) {
	if system == nil {
		return BootstrapPrincipals{}, errors.New("bootstrap principal system is unavailable")
	}
	names, err := BootstrapPrincipalNames(request.Profile, request.InstanceID, request.OperatorUser)
	if err != nil {
		return BootstrapPrincipals{}, err
	}
	if !filepath.IsAbs(request.OwnerStateRoot) || filepath.Clean(request.OwnerStateRoot) != request.OwnerStateRoot {
		return BootstrapPrincipals{}, errors.New("bootstrap owner state root is invalid")
	}
	groups := map[string]GroupRecord{}
	for _, name := range []string{names.GatewayGroup, names.SignerGroup, names.OperatorGroup, names.ConfigGroup} {
		group, ok, lookupErr := system.LookupGroup(ctx, name)
		if lookupErr != nil {
			return BootstrapPrincipals{}, lookupErr
		}
		if !ok {
			if err := system.AddGroup(ctx, name); err != nil {
				return BootstrapPrincipals{}, err
			}
			group, ok, lookupErr = system.LookupGroup(ctx, name)
		}
		if lookupErr != nil || !ok || group.Name != name || group.GID == 0 {
			return BootstrapPrincipals{}, fmt.Errorf("bootstrap group %s is unavailable or unsafe", name)
		}
		groups[name] = group
	}
	ownerHome := filepath.Dir(request.OwnerStateRoot)
	if filepath.Base(request.OwnerStateRoot) != ".fased" || filepath.Dir(ownerHome) == "/" {
		return BootstrapPrincipals{}, errors.New("bootstrap owner state root is not canonical")
	}
	operator, ok, err := system.LookupUser(ctx, names.OperatorUser)
	if err != nil {
		return BootstrapPrincipals{}, err
	}
	if !ok && request.Profile == model.ProfileHosting {
		if err := system.AddUser(ctx, AddUserRequest{Name: names.OperatorUser, Home: ownerHome, Shell: "/bin/bash", CreateHome: true}); err != nil {
			return BootstrapPrincipals{}, err
		}
		operator, ok, err = system.LookupUser(ctx, names.OperatorUser)
	}
	if err != nil || !ok || operator.Name != names.OperatorUser || operator.UID == 0 || operator.GID == 0 || operator.Home != ownerHome {
		return BootstrapPrincipals{}, errors.New("bootstrap operator identity is unavailable or unsafe")
	}
	serviceHomes := map[string]string{
		names.GatewayUser: filepath.Join("/var/lib/fased-local", request.InstanceID),
		names.SignerUser:  filepath.Join("/var/lib/fased-local", request.InstanceID, "signer"),
	}
	if request.Profile == model.ProfileHosting {
		serviceHomes[names.GatewayUser] = "/var/lib/fased-gateway"
		serviceHomes[names.SignerUser] = "/var/lib/fased-signerd"
	}
	ensureService := func(name, group string) (AccountRecord, error) {
		record, exists, lookupErr := system.LookupUser(ctx, name)
		if lookupErr != nil {
			return AccountRecord{}, lookupErr
		}
		created := false
		if !exists {
			if err := system.AddUser(ctx, AddUserRequest{Name: name, PrimaryGroup: group, Home: serviceHomes[name], Shell: "/usr/sbin/nologin", System: true}); err != nil {
				return AccountRecord{}, err
			}
			created = true
			record, exists, lookupErr = system.LookupUser(ctx, name)
		}
		if lookupErr != nil || !exists || record.Name != name || record.UID == 0 || record.GID != groups[group].GID || record.Home != serviceHomes[name] ||
			(record.Shell != "/usr/sbin/nologin" && record.Shell != "/sbin/nologin" && record.Shell != "/bin/false") {
			return AccountRecord{}, fmt.Errorf("bootstrap service identity %s differs from its canonical account", name)
		}
		if created {
			if err := system.LockUser(ctx, name); err != nil {
				return AccountRecord{}, err
			}
		}
		return record, nil
	}
	gateway, err := ensureService(names.GatewayUser, names.GatewayGroup)
	if err != nil {
		return BootstrapPrincipals{}, err
	}
	signer, err := ensureService(names.SignerUser, names.SignerGroup)
	if err != nil {
		return BootstrapPrincipals{}, err
	}
	if operator.UID == gateway.UID || operator.UID == signer.UID || gateway.UID == signer.UID {
		return BootstrapPrincipals{}, errors.New("bootstrap service identities are not isolated")
	}
	for user, memberships := range map[string][]string{
		names.OperatorUser: {names.OperatorGroup, names.ConfigGroup},
		names.GatewayUser:  {names.ConfigGroup},
		names.SignerUser:   {names.GatewayGroup, names.OperatorGroup},
	} {
		if err := system.AddMemberships(ctx, user, memberships); err != nil {
			return BootstrapPrincipals{}, err
		}
	}
	for _, removal := range [][2]string{{names.OperatorUser, names.GatewayGroup}, {names.OperatorUser, names.SignerGroup}, {names.GatewayUser, names.OperatorGroup}, {names.GatewayUser, names.SignerGroup}} {
		if err := system.RemoveMembership(ctx, removal[0], removal[1]); err != nil {
			return BootstrapPrincipals{}, err
		}
	}
	if request.Profile == model.ProfileHosting {
		for _, admin := range []string{"sudo", "wheel"} {
			if _, exists, lookupErr := system.LookupGroup(ctx, admin); lookupErr != nil {
				return BootstrapPrincipals{}, lookupErr
			} else if exists {
				if err := system.RemoveMembership(ctx, names.OperatorUser, admin); err != nil {
					return BootstrapPrincipals{}, err
				}
			}
		}
	}
	return BootstrapPrincipals{
		Names:    names,
		Operator: Principal{UID: operator.UID, GID: operator.GID},
		Gateway:  Principal{UID: gateway.UID, GID: gateway.GID},
		Signer:   Principal{UID: signer.UID, GID: signer.GID},
		Groups:   BootstrapGroups{Gateway: groups[names.GatewayGroup], Signer: groups[names.SignerGroup], Operator: groups[names.OperatorGroup], Config: groups[names.ConfigGroup]},
	}, nil
}

func BootstrapPathPlan(config Config, principals BootstrapPrincipals) ([]BootstrapPath, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if principals.Operator != config.Operator || principals.Gateway != config.Gateway || principals.Signer != config.Signer || principals.Groups.Config.GID == 0 {
		return nil, errors.New("bootstrap path principals do not match platform configuration")
	}
	paths := []BootstrapPath{{Path: config.InstallRoot, Mode: 0o755}}
	if config.Profile == model.ProfileProtectedLocal {
		paths = append(paths,
			BootstrapPath{Path: config.ProductStateRoot, Mode: 0o755},
			BootstrapPath{Path: filepath.Join(config.ProductStateRoot, "controller"), GID: config.Operator.GID, Mode: 0o710},
			BootstrapPath{Path: config.LifecycleRoot, Mode: 0o700},
			BootstrapPath{Path: config.SignerStateRoot(), UID: config.Signer.UID, GID: config.Signer.GID, Mode: 0o700},
		)
	} else {
		paths = append(paths,
			BootstrapPath{Path: config.LifecycleRoot, Mode: 0o700},
			BootstrapPath{Path: config.SignerStateRoot(), UID: config.Signer.UID, GID: config.Signer.GID, Mode: 0o700},
			BootstrapPath{Path: "/var/lib/fased-signer-update-gate", GID: config.Signer.GID, Mode: 0o750},
		)
	}
	paths = append(paths,
		BootstrapPath{Path: config.OwnerStateRoot, UID: config.Operator.UID, GID: principals.Groups.Config.GID, Mode: os.ModeSetgid | 0o770},
		BootstrapPath{Path: filepath.Join(config.OwnerStateRoot, "bin"), UID: config.Operator.UID, GID: principals.Groups.Config.GID, Mode: 0o750},
	)
	return paths, nil
}

func ApplyBootstrapPathPlan(paths []BootstrapPath) error {
	changes, err := ApplyBootstrapPathPlanTransactional(paths)
	if err != nil {
		return err
	}
	changes.Commit()
	return nil
}
