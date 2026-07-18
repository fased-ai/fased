package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
)

var jsonRawMessageTypeV2 = reflect.TypeOf(json.RawMessage{})

func validateJSONNoDuplicateKeysV2(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := scanJSONValueNoDuplicateKeysV2(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains trailing data")
		}
		return err
	}
	return nil
}

func scanJSONValueNoDuplicateKeysV2(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, exists := seen[key]; exists {
				return fmt.Errorf("JSON object contains duplicate key %q", key)
			}
			seen[key] = struct{}{}
			if err := scanJSONValueNoDuplicateKeysV2(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil {
			return err
		}
		if closing != json.Delim('}') {
			return errors.New("JSON object is not terminated")
		}
	case '[':
		for decoder.More() {
			if err := scanJSONValueNoDuplicateKeysV2(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil {
			return err
		}
		if closing != json.Delim(']') {
			return errors.New("JSON array is not terminated")
		}
	default:
		return errors.New("invalid JSON delimiter")
	}
	return nil
}

func decodeStrictJSONV2(raw []byte, out any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return errors.New("JSON value is required")
	}
	if err := validateJSONNoDuplicateKeysV2(raw); err != nil {
		return err
	}
	var shape any
	shapeDecoder := json.NewDecoder(bytes.NewReader(raw))
	shapeDecoder.UseNumber()
	if err := shapeDecoder.Decode(&shape); err != nil {
		return err
	}
	target := reflect.TypeOf(out)
	if target == nil || target.Kind() != reflect.Pointer || target.Elem().Kind() == reflect.Invalid {
		return errors.New("strict JSON destination must be a non-nil pointer")
	}
	if err := validateExactJSONFieldNamesV2(shape, target.Elem()); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains trailing data")
		}
		return err
	}
	return nil
}

func validateExactJSONFieldNamesV2(value any, target reflect.Type) error {
	for target.Kind() == reflect.Pointer {
		target = target.Elem()
	}
	if target == jsonRawMessageTypeV2 || target.Kind() == reflect.Interface {
		return nil
	}
	switch target.Kind() {
	case reflect.Struct:
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		fields := make(map[string]reflect.Type)
		collectExactJSONFieldsV2(target, fields)
		for key, child := range object {
			fieldType, exists := fields[key]
			if !exists {
				return fmt.Errorf("JSON object contains unknown or non-canonical field %q", key)
			}
			if err := validateExactJSONFieldNamesV2(child, fieldType); err != nil {
				return err
			}
		}
	case reflect.Slice, reflect.Array:
		items, ok := value.([]any)
		if !ok {
			return nil
		}
		for _, item := range items {
			if err := validateExactJSONFieldNamesV2(item, target.Elem()); err != nil {
				return err
			}
		}
	case reflect.Map:
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		for _, child := range object {
			if err := validateExactJSONFieldNamesV2(child, target.Elem()); err != nil {
				return err
			}
		}
	}
	return nil
}

func collectExactJSONFieldsV2(target reflect.Type, fields map[string]reflect.Type) {
	for index := 0; index < target.NumField(); index++ {
		field := target.Field(index)
		if field.PkgPath != "" {
			continue
		}
		tag := field.Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "-" {
			continue
		}
		if field.Anonymous && name == "" {
			embedded := field.Type
			for embedded.Kind() == reflect.Pointer {
				embedded = embedded.Elem()
			}
			if embedded.Kind() == reflect.Struct {
				collectExactJSONFieldsV2(embedded, fields)
				continue
			}
		}
		if name == "" {
			name = field.Name
		}
		fields[name] = field.Type
	}
}

func decodeSignerEnvelopeV2(raw []byte) (request, map[string]any, error) {
	var req request
	if err := decodeStrictJSONV2(raw, &req); err != nil {
		return request{}, nil, err
	}
	var fingerprintInput map[string]any
	if err := json.Unmarshal(raw, &fingerprintInput); err != nil {
		return request{}, nil, err
	}
	if fingerprintInput == nil {
		return request{}, nil, errors.New("signer request must be a JSON object")
	}
	return req, fingerprintInput, nil
}
