package graphview

import (
	"encoding/json"
	"errors"
)

// MarshalBrowserResponse bounds the complete JSON payload, including sidebar
// groups and lens observations. Encode nodes and edges one at a time so an
// oversized graph never needs to be materialized as one large JSON string.
func MarshalBrowserResponse(response Response) ([]byte, error) {
	return marshalResponse(response, 32<<20)
}

var errResponseSize = errors.New("graph response exceeds the browser size limit")

func marshalResponse(response Response, limit int) ([]byte, error) {
	// Inherit the normal field tags for the rest of the response. The two
	// potentially large arrays are appended below using the same JSON encoder.
	header, err := json.Marshal(struct {
		Response
		Nodes bool `json:"nodes,omitempty"`
		Edges bool `json:"edges,omitempty"`
	}{Response: response})
	if err != nil {
		return nil, err
	}
	// Keep the final closing brace in the budget.
	if len(header) > limit {
		return nil, errResponseSize
	}
	body, err := appendRows(header[:len(header)-1], `,"nodes":`, response.Nodes, limit-1)
	if err != nil {
		return nil, err
	}
	body, err = appendRows(body, `,"edges":`, response.Edges, limit-1)
	if err != nil {
		return nil, err
	}
	return append(body, '}'), nil
}

func appendRows[T any](body []byte, field string, rows []T, limit int) ([]byte, error) {
	if rows == nil {
		if len(field)+len("null") > limit-len(body) {
			return nil, errResponseSize
		}
		body = append(body, field...)
		return append(body, "null"...), nil
	}
	if len(field)+2 > limit-len(body) {
		return nil, errResponseSize
	}
	body = append(body, field...)
	body = append(body, '[')
	for i, row := range rows {
		raw, err := json.Marshal(row)
		if err != nil {
			return nil, err
		}
		if i > 0 {
			body = append(body, ',')
		}
		if len(raw) >= limit-len(body) { // reserve the closing bracket
			return nil, errResponseSize
		}
		body = append(body, raw...)
	}
	return append(body, ']'), nil
}
