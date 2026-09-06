# Container Registry in Workers

This repository contains a container registry implementation in Workers that uses R2.

It supports all pushing and pulling workflows. It also supports
Username/Password and public key JWT based authentication.

### Deployment

You have to install all the dependencies with [pnpm](https://pnpm.io/installation) (other package managers may work, but only pnpm is supported.)

```bash
$ pnpm install
```

After installation, there are a few steps to actually deploy the registry into production:

1. Create your own wrangler config file based on the example files in this repo.

Cloudflare recommends [`wrangler.jsonc`](https://developers.cloudflare.com/workers/wrangler/configuration/) for new projects, but `wrangler.toml` is also supported. Pick whichever you prefer:

```bash
# JSONC (recommended)
$ cp wrangler.example.jsonc wrangler.jsonc

# or TOML
$ cp wrangler.example.toml wrangler.toml
```

2. Setup the R2 Bucket for this registry

```bash
$ npx wrangler --env production r2 bucket create r2-registry
```

Add this to your wrangler config file:

```jsonc
// wrangler.jsonc
"r2_buckets": [
  { "binding": "REGISTRY", "bucket_name": "r2-registry" }
]
```

```toml
# wrangler.toml
r2_buckets = [
  { binding = "REGISTRY", bucket_name = "r2-registry" }
]
```

3. Deploy your image registry

```bash
$ npx wrangler deploy --env production
```

Your registry should be up and running. It will refuse any requests if you don't setup credentials.

### Adding username password based authentication

Set the USERNAME and PASSWORD as secrets with `npx wrangler secret put USERNAME --env production` and `npx wrangler secret put PASSWORD --env production`.

### Adding JWT authentication with public key

You can add a base64 encoded JWT public key to verify passwords (or token) that are signed by the private key.
`npx wrangler secret put JWT_REGISTRY_TOKENS_PUBLIC_KEY --env production`

Tokens are bound to a single registry. Every token must carry an `aud` claim naming
the registry it is for, and a request is rejected with `401` unless `aud` matches the
host it arrived on. `createToken()` sets this from its `registryUrl` argument. Only
host and port are compared, so `https://registry.example`, `http://registry.example`
and `registry.example` are equivalent, but `registry.example:8787` is a different
registry from `registry.example`.

**Give each deployment its own key pair.** This registry has no per-account or
per-repository scoping: any token that verifies grants the full extent of its
capabilities over the whole registry. Deployments sharing a
`JWT_REGISTRY_TOKENS_PUBLIC_KEY` therefore form one trust domain, and the `aud` check
is all that separates them.

### Using with Docker

You can use this registry with Docker to push and pull images.

Example using `docker push` and `docker pull`:

```bash
export REGISTRY_URL=your-url-here

# Replace $PASSWORD and $USERNAME with the actual credentials
echo $PASSWORD | docker login --username $USERNAME --password-stdin $REGISTRY_URL
docker pull ubuntu:latest
docker tag ubuntu:latest $REGISTRY_URL/ubuntu:latest
docker push $REGISTRY_URL/ubuntu:latest

# Check that pulls work
docker rmi ubuntu:latest $REGISTRY_URL/ubuntu:latest
docker pull $REGISTRY_URL/ubuntu:latest
```

### Configuring Pull fallback

You can configure the R2 registry to fallback to another registry if
it doesn't exist in your R2 bucket. It will download from the registry
and copy it into the R2 bucket. In the next pull it will be able to pull it directly from R2.

This is very useful for migrating from one registry to `serverless-registry`.

It supports both Basic and Bearer authentications as explained in the
[registry spec](https://distribution.github.io/distribution/spec/auth/token/).

In your wrangler config file:

```jsonc
// wrangler.jsonc
"env": {
  "production": {
    "vars": {
      "REGISTRIES_JSON": "[{ \"registry\": \"https://url-to-other-registry\", \"password_env\": \"REGISTRY_TOKEN\", \"username\": \"username-to-use\" }]"
    }
  }
}
```

```toml
# wrangler.toml
[env.production.vars]
REGISTRIES_JSON = "[{ \"registry\": \"https://url-to-other-registry\", \"password_env\": \"REGISTRY_TOKEN\", \"username\": \"username-to-use\" }]"
```

Set as a secret the registry token of the registry you want to setup
pull fallback in.

For example [gcr](https://cloud.google.com/artifact-registry/docs/reference/docker-api):

```
cat ./registry-service-credentials.json | base64 | npx wrangler secret put REGISTRY_TOKEN --env production
```

[Github](https://github.com/settings/tokens) for example uses a simple token that you can copy.

```
echo $GITHUB_TOKEN | npx wrangler secret put REGISTRY_TOKEN --env production
```

The trick is always looking for how you would login in Docker for
the target registry and setup the credentials.

**Never put a registry password/token inside your wrangler config file, please always use `wrangler secrets put`**

You can also use docker.io with anonymous authentication:

```jsonc
// wrangler.jsonc
"REGISTRIES_JSON": "[{ \"registry\": \"https://index.docker.io/\" }]"
```

```toml
# wrangler.toml
REGISTRIES_JSON = "[{ \"registry\": \"https://index.docker.io/\" }]"
```

You can also set your `docker.io` credentials in the configuration to not have any rate-limiting.

### Known limitations

Right now there is some limitations with this container registry.

- Pushing with docker is limited to images that have layers of maximum size 500MB. Refer to maximum request body sizes in your Workers plan.
- To circumvent that limitation, you can either manually interact with the R2 bucket to upload the layer or take a
  peek at the `./push` folder for some inspiration on how can you push big layers.
- If you use `npx wrangler dev` and push to the R2 registry with docker, the R2 registry will have to buffer the request on the Worker.

## License

The project is licensed under the [Apache License](https://opensource.org/licenses/apache-2.0/).

### Contribution

See `CONTRIBUTING.md` for contributing to the project.

### Finalizing layers larger than 5 GiB

Chunked client uploads alone do not avoid R2's 5 GiB single-PUT limit. Large temporary upload
objects are finalized using a second multipart upload, with native streams over at most 32 MiB
per part and streaming SHA-256
verification before completion. The destination is invisible until all parts and the expected
hash have been verified. Multipart objects carry server-written verified-digest metadata because
R2 does not populate the native whole-object SHA-256 field for them. GET, HEAD and mounted-layer
resolution accept this metadata only when it matches the requested immutable digest.

Production examples set a 120,000 ms Worker CPU limit for streaming verification of large layers.
A 13,026,507,287-byte layer exceeded the previous 30-second CPU budget during finalization
(error 1102; observed CPU 32.5 seconds). Keep this limit in deployment configuration; client
chunk sizes do not reduce the total hashing work. Native `pipeTo` avoids JavaScript work for
every source chunk, while a bounded per-part `tee` prevents whole-layer buffering. A rejected
part is drained within that bound before aborting the destination, so both early and late
provider failures can be retried. This is a CPU ceiling, not a billing cap.

A failed finalization retains the temporary object for retry and aborts the destination multipart
upload. Repeated copies reuse an already verified destination. Existing small blobs retain native
R2 checksum verification. Upload state cleanup and source removal occur after a successful copy.

Tests exercise multipart boundaries with a reduced 5 MiB part size, wrong hashes, provider failure
after receiving a part, duplicate delivery, and registry GET/HEAD/mount. These local tests are not
a live >5 GiB upload proof; validate a real large layer on the deployed registry before claiming
that integration gate. Client HTTP/2 peer resets are a separate transport issue.

Rollback: small existing blobs are backward compatible. Once large multipart blobs have been
published, retain the verified-metadata reader when reverting the writer; an older reader that
requires R2's native SHA-256 field cannot read those new blobs. Do not delete stored artifacts as
part of a code rollback.
