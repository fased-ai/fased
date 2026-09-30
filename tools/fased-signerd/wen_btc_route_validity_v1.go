package main

import (
	"errors"
	"strconv"
)

// Protected local review metadata, bound to the route hash in the same review.
// This is an age limit, not evidence that a provider quote will execute. The
// instruction, custody, amount floor and exact-message simulation still apply.
type signerWENBTCRouteValidityV1 struct {
	ObservedSlot uint64 `json:"observedSlot,string"`
	ExpiresSlot  uint64 `json:"expiresSlot,string"`
}

func (r signerWENBTCReviewV1) validateRouteValidity() error {
	bad := errors.New("WEN BTC route validity requires reviewed slot bounds")
	if r.Intent.Operation != "acquisition" {
		if r.RouteValidity != nil {
			return bad
		}
		return nil
	}
	v := r.RouteValidity
	min, e1 := strconv.ParseUint(r.Intent.MinFinalizedSlot, 10, 64)
	expires, e2 := strconv.ParseUint(r.Intent.ExpiresSlot, 10, 64)
	if v == nil || e1 != nil || e2 != nil || v.ObservedSlot == 0 || v.ObservedSlot < min || v.ExpiresSlot <= v.ObservedSlot || v.ExpiresSlot > expires {
		return bad
	}
	return nil
}

func (r signerWENBTCReviewV1) checkRouteSlot(slot uint64) error {
	if err := r.validateRouteValidity(); err != nil {
		return err
	}
	if r.Intent.Operation != "acquisition" {
		return nil
	}
	v := r.RouteValidity
	if slot < v.ObservedSlot || slot >= v.ExpiresSlot || slot-v.ObservedSlot > r.MaxSlotLag {
		return errors.New("WEN BTC reviewed route stale or expired; refresh review")
	}
	return nil
}
