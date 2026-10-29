# Changelog

## 0.1.0 (2026-10-29)


### Features

* add login save and pending navigation UI ([d44a275](https://github.com/rshade/golink_chrome_extension/commit/d44a275346fb11e391ab5bdb1e363730d3af6457))
* add navigation and suggestion helpers ([e639b74](https://github.com/rshade/golink_chrome_extension/commit/e639b745fec56695f87ef9c7937b44fdddf50347))
* add tested golink HTTP client ([25fe282](https://github.com/rshade/golink_chrome_extension/commit/25fe282df0df0b8bbea8c9de260c7d0e7a6ca8f2))
* coordinate offscreen node lifecycle and durable login ([6ffe669](https://github.com/rshade/golink_chrome_extension/commit/6ffe66905c5b1d7d44ae28622f6fe1f8f9616767))
* embed Tailscale WASM node and Promise bridge ([a521a7b](https://github.com/rshade/golink_chrome_extension/commit/a521a7b7213e40841038e11c58a5d46ac17e4160))
* pack a signed CRX with a stable extension ID ([d84ab0e](https://github.com/rshade/golink_chrome_extension/commit/d84ab0e683cbcfa01ee7b38d20cb4f83b23acf21))
* persist node state with serialized epochs ([0b10641](https://github.com/rshade/golink_chrome_extension/commit/0b106417b9c7d202f00840b00b276bd6c71ac246))
* route go links and browser actions through the node ([36c4633](https://github.com/rshade/golink_chrome_extension/commit/36c4633af5611fd41913a094c5f089b62a4c8a50))


### Bug Fixes

* address code review findings before initial release ([77ae5d0](https://github.com/rshade/golink_chrome_extension/commit/77ae5d060c70db2779c8ebe4b253e2d4577c264e))
* classify golink export body transport failures ([5b110dc](https://github.com/rshade/golink_chrome_extension/commit/5b110dc8b9e644556446d28c726151ad55ad228a))
* clear pending spinner during recovery actions ([def05b7](https://github.com/rshade/golink_chrome_extension/commit/def05b76a0df583f28c67573b149c98c98c1122a))
* **deps:** update github.com/tailscale/golink digest to d02fb07 ([e8f3430](https://github.com/rshade/golink_chrome_extension/commit/e8f34300dc076fe2af937dd756b230a5dfe9ccaf))
* **deps:** update github.com/tailscale/golink digest to d02fb07 ([9d5c582](https://github.com/rshade/golink_chrome_extension/commit/9d5c582f940fc239693d9fd5a8d4263305216148))
* **deps:** update module tailscale.com to v1.104.4 ([70bce03](https://github.com/rshade/golink_chrome_extension/commit/70bce03af7f0212ce9cb3fcacd8157e7f73bdc70))
* **deps:** update module tailscale.com to v1.104.4 ([36bcafe](https://github.com/rshade/golink_chrome_extension/commit/36bcafe6410b41b0982976fcc9329387e7607881))
* keep the baked-in Let's Encrypt roots in the WASM build ([36d4131](https://github.com/rshade/golink_chrome_extension/commit/36d413111e706e928c4da3774a337b8663e9947f))
* refresh links after replacement reaches Running ([d1cee5f](https://github.com/rshade/golink_chrome_extension/commit/d1cee5f604537b6623cc33eba3af3a9b84989563))
* reject commands from a framed status page ([c613739](https://github.com/rshade/golink_chrome_extension/commit/c6137395601e9de6473f789901af07fddefed7c1))
* retain document ownership for delayed link navigation ([eb632f7](https://github.com/rshade/golink_chrome_extension/commit/eb632f7c298ac1717517abc5d1b142f03b9b4a71))
