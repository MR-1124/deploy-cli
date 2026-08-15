# Provider: S3

Deploys static files to an S3 bucket using **AWS Signature V4** signing
implemented from scratch — no AWS SDK dependency.

## Setup

1. Create an access key with `s3:PutObject` (and `s3:ListBucket`) on your
   bucket. Bucket must have static website hosting enabled if you want a
   browser-friendly URL.
2. Save the credentials:

```bash
deploy login --provider s3 --access-key <AK> --secret-key <SK> --bucket <name> --region us-east-1
# optional key prefix (default: project name)
deploy login --provider s3 --access-key <AK> --secret-key <SK> --bucket <name> --prefix my-site
```

`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars also work.

## Deploy

```bash
deploy up --provider s3
# → s3://<bucket>/<project>/
#   URL: https://<bucket>.s3.<region>.amazonaws.com/<project>/
```

Every file is a SigV4-signed `PutObject` under `s3://<bucket>/<prefix>/<path>`.
The object-store URL is printed; if the bucket has website hosting enabled,
your real URL is `https://<bucket>.s3-website-<region>.amazonaws.com/<prefix>/`.

## Rollback

```bash
deploy rollback <id> --provider s3
# ✖ S3 has no built-in rollback — restore from a previous deploy's files …
```

Plain S3 has no aliases or version pointer, so rollback isn't supported — the
command says so clearly. Options: enable S3 versioning and serve through a
proxy, or re-upload the previous content.

## List

`deploy list --provider s3` uses `ListObjectsV2` and shows the objects under
the prefix.

## Security notes

- Every request (including listings) is SigV4-signed — nothing is public
  unless your bucket policy says so.
- Test endpoints via `AWS_S3_ENDPOINT` (the test suite uses this to run
  against a mock that recomputes and verifies each signature).
