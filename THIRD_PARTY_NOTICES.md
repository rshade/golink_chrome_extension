# Third-party notices

This extension's own code is released under the BSD 3-Clause license in
`LICENSE`, the same license Tailscale uses. The notices below cover code and
modules from other projects.

The Tailscale node setup, Promise helper, log policy, and logging transport in wasm/node_js.go and wasm/bridge_js.go are adapted from tailscale.com v1.104.2, cmd/tsconnect/wasm/wasm_js.go. SSH, terminal, peer presentation, hostname generation, upstream fetch, and upstream global APIs have been removed. State and the public API are adapted for this extension.

Source: https://github.com/tailscale/tailscale/blob/v1.104.2/cmd/tsconnect/wasm/wasm_js.go

The upstream source carries this notice:

Copyright (c) Tailscale Inc & contributors

SPDX-License-Identifier: BSD-3-Clause

BSD 3-Clause License

Copyright (c) 2020 Tailscale Inc & contributors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
