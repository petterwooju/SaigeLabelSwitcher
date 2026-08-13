# image-size 2.0.3-saige.2

This package is a narrow downstream rebuild of `image-size@2.0.2` for the
SaigeVision Project Converter. The upstream license is preserved in `LICENSE`.

It backports progress validation for the three loops covered by:

- GHSA-w3rx-r6r6-pgpr (zero-length ICNS entries)
- GHSA-5p2g-fcmc-qvqq (zero-sized HEIF/JXL boxes)

`apply-security-patch.mjs` performs and count-checks the mechanical patch over
the upstream ESM and CommonJS bundles. The root project tests the published
tarball against the three proof-of-concept inputs in isolated child processes.

Replace this package with an official upstream release as soon as a patched
version is published.
