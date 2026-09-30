package main

import "testing"

func TestWENBTCRouteValidity(t *testing.T) {
	for _, name := range []string{"valid", "age-boundary", "missing", "zero", "before-intent", "empty-window", "past-intent", "future", "stale", "expired", "acceptance-extra", "acceptance"} {
		t.Run(name, func(t *testing.T) {
			r := signerWENBTCReviewV1{Intent: signerWENBTCIntentV1{Operation: "acquisition", MinFinalizedSlot: "100", ExpiresSlot: "200"}, MaxSlotLag: 5, RouteValidity: &signerWENBTCRouteValidityV1{ObservedSlot: 150, ExpiresSlot: 160}}
			slot := uint64(154)
			switch name {
			case "age-boundary":
				slot = 155
			case "missing":
				r.RouteValidity = nil
			case "zero":
				r.RouteValidity.ObservedSlot = 0
			case "before-intent":
				r.RouteValidity.ObservedSlot = 99
			case "empty-window":
				r.RouteValidity.ExpiresSlot = 150
			case "past-intent":
				r.RouteValidity.ExpiresSlot = 201
			case "future":
				slot = 149
			case "stale":
				slot = 156
			case "expired":
				r.RouteValidity.ExpiresSlot = 154
			case "acceptance-extra":
				r.Intent.Operation = "acceptance"
			case "acceptance":
				r.Intent.Operation = "acceptance"
				r.RouteValidity = nil
			}
			err := r.checkRouteSlot(slot)
			ok := name == "valid" || name == "age-boundary" || name == "acceptance"
			if (err == nil) != ok {
				t.Fatalf("unexpected route admission: %v", err)
			}
		})
	}
}
