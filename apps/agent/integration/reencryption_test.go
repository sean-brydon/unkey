package integration

import (
	"context"
	"crypto/rand"
	"fmt"
	"math"
	"testing"

	"github.com/stretchr/testify/require"
	vaultv1 "github.com/unkeyed/unkey/apps/agent/gen/proto/vault/v1"
	"github.com/unkeyed/unkey/apps/agent/pkg/logging"
	"github.com/unkeyed/unkey/apps/agent/services/vault"
	"github.com/unkeyed/unkey/apps/agent/services/vault/keys"
	"github.com/unkeyed/unkey/apps/agent/services/vault/storage"
)

// This scenario tests the re-encryption of a secret
func TestReEncrypt(t *testing.T) {

	logger := logging.New(nil)

	storage, err := storage.NewMemory(storage.MemoryConfig{
		Logger: logger,
	})
	require.NoError(t, err)

	_, masterKey, err := keys.GenerateMasterKey()
	require.NoError(t, err)

	v, err := vault.New(vault.Config{
		Storage:    storage,
		Logger:     logger,
		MasterKeys: []string{masterKey},
	})
	require.NoError(t, err)

	ctx := context.Background()

	for i := 1; i < 9; i++ {

		dataSize := int(math.Pow(8, float64(i)))
		t.Run(fmt.Sprintf("with %d bytes", dataSize), func(t *testing.T) {

			keyring := fmt.Sprintf("keyring-%d", i)
			buf := make([]byte, dataSize)
			_, err := rand.Read(buf)
			require.NoError(t, err)

			data := string(buf)

			enc, err := v.Encrypt(ctx, &vaultv1.EncryptRequest{
				Keyring: keyring,
				Data:    data,
			})
			require.NoError(t, err)

			deks := []string{}
			for j := 0; j < 100; j++ {
				dek, err := v.CreateDEK(ctx, &vaultv1.CreateDEKRequest{
					Keyring: keyring,
				})
				require.NoError(t, err)
				require.NotContains(t, deks, dek.KeyId)
				deks = append(deks, dek.KeyId)
				_, err = v.ReEncrypt(ctx, &vaultv1.ReEncryptRequest{
					Keyring:   keyring,
					Encrypted: enc.Encrypted,
				})
				require.NoError(t, err)
			}

			dec, err := v.Decrypt(ctx, &vaultv1.DecryptRequest{
				Keyring:   keyring,
				Encrypted: enc.Encrypted,
			})
			require.NoError(t, err)
			require.Equal(t, data, dec.Plaintext)
		})

	}

}
