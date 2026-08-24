# Third-party notices

The optional embedded `dsh-deeppilot-tunnel` helper is built with
[`tailscale.com/tsnet`](https://github.com/tailscale/tailscale), distributed
under the BSD 3-Clause License.

Binary redistributions of the helper include the detected dependency license
texts under `third_party/licenses/`. That directory is generated from the
pinned Go module graph with `go-licenses`; it must be regenerated and reviewed
whenever `helper/go.mod` or `helper/go.sum` changes.

The repository source and license are available at:

- https://github.com/tailscale/tailscale
- https://github.com/tailscale/tailscale/blob/main/LICENSE

The browser settings bundle uses [`qrcode`](https://github.com/soldair/node-qrcode)
and its bundled `dijkstrajs` dependency to generate pairing QR codes entirely
in the local browser. Both are distributed under the MIT License; their texts
are included under `third_party/licenses/npm/`.
