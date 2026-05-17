package app

import (
	"sync"
	"time"
)

type ttlCache[T any] struct {
	mu         sync.RWMutex
	ttl        time.Duration
	maxEntries int
	items      map[string]ttlCacheEntry[T]
	now        func() time.Time
}

type ttlCacheEntry[T any] struct {
	value     T
	expiresAt time.Time
}

func newTTLCache[T any](ttl time.Duration, maxEntries int) *ttlCache[T] {
	if maxEntries <= 0 {
		maxEntries = 256
	}
	return &ttlCache[T]{
		ttl:        ttl,
		maxEntries: maxEntries,
		items:      make(map[string]ttlCacheEntry[T]),
		now:        time.Now,
	}
}

func (c *ttlCache[T]) get(key string) (T, bool) {
	var zero T
	if c == nil || c.ttl <= 0 {
		return zero, false
	}

	c.mu.RLock()
	entry, ok := c.items[key]
	if !ok || !c.now().Before(entry.expiresAt) {
		c.mu.RUnlock()
		if ok {
			c.delete(key)
		}
		return zero, false
	}
	c.mu.RUnlock()
	return entry.value, true
}

func (c *ttlCache[T]) set(key string, value T) {
	if c == nil || c.ttl <= 0 {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.items) >= c.maxEntries {
		c.pruneLocked()
	}
	c.items[key] = ttlCacheEntry[T]{
		value:     value,
		expiresAt: c.now().Add(c.ttl),
	}
}

func (c *ttlCache[T]) delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.items, key)
}

func (c *ttlCache[T]) pruneLocked() {
	now := c.now()
	for key, entry := range c.items {
		if !now.Before(entry.expiresAt) {
			delete(c.items, key)
		}
	}
	if len(c.items) < c.maxEntries {
		return
	}
	for key := range c.items {
		delete(c.items, key)
		if len(c.items) < c.maxEntries {
			return
		}
	}
}
