# Stream on Cloudflare

Both deployment configurations use the same Worker, public hostnames and SQLite-backed Durable Object. The object named `pilot-live` owns signups, sessions, encrypted R2 credentials, publications and payments. Its vault key is a stable Worker secret. Filmmakers keep their films in their own R2 buckets.

## Publish the workspace

From a clean Stream checkout with its pinned submodule and supported Node version, run `npm ci`. Set Cloudflare secrets with `npx wrangler secret put NAME --config wrangler.edge.jsonc`. Keep an encrypted recovery copy of the vault key and viewer signing key in the operator's secret manager. Generate independent 32-byte base64url values using a password manager or cryptographic random generator.

| Workspace setting | Value |
| --- | --- |
| STREAM_VAULT_KEY | Stable 32-byte base64url key for the private R2 credential vault |
| STREAM_TURNSTILE_SITE_KEY, STREAM_TURNSTILE_SECRET_KEY | Managed widget authorized for streamyourfilm.com |
| RESEND_API_KEY, STREAM_RECOVERY_FROM | Sending key and verified sender |
| STREAM_ADMIN_EMAIL | Operator email for the separate admin login |

Run `npx wrangler deploy --config wrangler.edge.jsonc` to publish signup, sign-in, the agreement and FAQ. Open the public home and verify a real email sign-in. Check both the filmmaker and admin paths. During this phase the viewing hostname returns an explicit temporary-unavailable response.

## Enable the full app

The full configuration requires Workers Paid and Cloudflare Containers with a Linux/amd64 image. Use a Docker-compatible builder. The app starts one named container on demand, and it sleeps after two idle minutes. Its disk holds transient process data. Each setup or payment operation commits to the same Durable Object used by the initial workspace. Signed media grants and paid access survive compute restarts.

| Additional setting | Value |
| --- | --- |
| STREAM_RENTAL_SECRET | Stable independent 32-byte base64url viewer signing key |
| STREAM_STORE_TOKEN | Independent 32-byte base64url internal storage bridge secret |
| STREAM_MAINTENANCE_SECRET | Independent 32-byte base64url private maintenance secret |
| STRIPE_CONNECT_SECRET_KEY, STRIPE_CONNECT_PUBLISHABLE_KEY | Matching live platform keys |
| STRIPE_CONNECT_WEBHOOK_SECRET, STRIPE_PLATFORM_WEBHOOK_SECRET | Distinct signing secrets for the live connected-account and platform destinations |
| STRIPE_CONNECT_CLIENT_ID | Live Connect client ID for the existing-account OAuth path |
| STREAM_SALES_TERRITORIES | Approved sales territories. Use `closed` while configuring checkout. An unset value also closes new sales. |

On a Mac using Podman, set `WRANGLER_DOCKER_BIN` to the absolute path of `deploy/podman-docker` and set `DOCKER_HOST` to the Unix socket reported by `podman machine inspect`. The adapter handles Wrangler’s Docker build flags and records the registry manifest digest returned by the push. Podman’s local image digest can differ from the published image after compression.

Install the additional secrets on the same Worker. Run `npx wrangler deploy --config wrangler.full.jsonc`. The container needs the network namespace and filesystem isolation supplied by Bubblewrap. Its entrypoint verifies that the decoder cannot see the private storage network, application files, process list or service secrets. It then decodes a generated 16 × 16 white frame through the isolated film input before opening either application port. It reports readiness only after both services respond. Run `node scripts/check-hosted-runtime.js` with the private maintenance secret to verify the public edge and media origin separately. The probe wakes one sleeping instance and reads the release and sales territory supplied by the running application. Set `STREAM_EXPECT_RELEASE` and `STREAM_EXPECT_TERRITORY` to assert them after a rollout. Sign-in and the FAQ run at the edge and leave the media instance asleep. A host where the kernel disallows that isolation fails startup. Verify an actual decode, seek, caption switch, and a first-time signup to its saved dashboard on the deployed build.

Only the two public application ports receive viewer traffic. The Worker makes authenticated maintenance calls on a separate private port whenever a 15-minute check finds work due. The internal storage address is intercepted inside the container's network. Each FFmpeg process runs in a separate network and PID namespace, sees a single bounded source socket, and receives a cleared environment. The vault key stays in the Durable Object. On a new Worker version, the next media request starts the application with the deployed image and current secrets. This also applies to changes in checkout territories.

## Recovery and operations

Cloudflare's SQLite Durable Objects support 30 days of point-in-time recovery. Record a recovery bookmark before a schema change, and preserve the namespace ID and exact vault key across deployments. A restored financial ledger can predate real Stripe charges or transfers. Close new sales, stop reconciliation while recovering, compare Stripe's records with the restored ledger, and reconcile outstanding grants and transfers before reopening. Rolling back to the previously working full release keeps existing buyers' playback and download routes. The edge-only deployment supports sign-in and omits playback.

Measure cold startup, throttled queues, media errors and service duration on the production instance. Configure a Workers usage notification for the operator. Containers bill provisioned memory and disk while running, plus active CPU and eligible egress. The 2-GiB, 1-vCPU instance and the short idle timeout are sized for a small pilot.

[Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) · [Container lifecycle and temporary disk](https://developers.cloudflare.com/containers/concepts/) · [Private Worker bindings from a container](https://developers.cloudflare.com/containers/configuration/workers-connections/) · [Durable Object point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#point-in-time-recovery-api)
