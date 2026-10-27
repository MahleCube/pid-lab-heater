# PID Lab

Learn how P, PI and PID control behave by experimenting with a virtual heater.

**[Open PID Lab](https://mahlecube.github.io/pid-lab/)** · **[GitHub repository](https://github.com/MahleCube/pid-lab)**

Developed by [MahleCube](https://github.com/MahleCube).

## Explore

- Adjust proportional gain, integral time, derivative time and control period.
- Change the heater's gain, time constant, dead time, temperatures and output limit separately from the controller.
- Compare two independent configurations side by side, using matching chart scales.
- Compare positional and incremental controller calculations.
- Step through the calculations, including the previous integral value and previous calculated command.
- See how output limits and integral anti-windup affect the response.

The first visit starts in English. A prominent language selector includes permanent hints in all supported languages: English, Japanese, Simplified Chinese, Traditional Chinese, Korean, Spanish, Brazilian Portuguese, French, German and Indonesian. The browser remembers the selected language when local storage is available.

The application runs entirely in the browser. It has no runtime package dependencies, account requirement, analytics or application backend. GitHub Pages itself handles web hosting. Simulation and language selection work offline with the bundled file.

## Use offline

Download [`pid-lab.html`](https://github.com/MahleCube/pid-lab/blob/main/pid-lab.html) using GitHub's **Download raw file** action, then open the saved file in a browser. It contains the application, styles and translations in one file. You can also clone the repository and open `index.html` locally.

## Model

The virtual heater is a first-order system with an input delay:

```text
temperature rate = (ambient + plant gain × delayed heater output − temperature) / time constant
Ki = Kp / Ti
Kd = Kp × Td
```

Output is a percentage of rated maximum heater power. Controller commands are held between updates; the temperature evolves continuously between updates and delayed-command arrivals. Derivative action uses measured temperature with a low-pass filter. Both controller forms retain the calculated command separately from the clipped actual output.

Settling time is the first time after which temperature remains within ±0.1°C of the target for the rest of the displayed observation period. A finite simulation does not establish stability for every operating condition. This is an educational model, not a source of qualified tuning values or safety guarantees for real hardware.

## Build and test

Node.js 20 or newer is required for development. The application itself only needs a browser.

```sh
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:ui
```

`npm test` checks the numerical engine. The UI suite checks basic operations, A/B comparisons, language persistence, translations and responsive layouts. By default it uses Playwright's Chromium. To use an installed compatible browser instead, set `PID_BROWSER_CHANNEL` to a supported Playwright channel such as `msedge` or `chrome` before running UI tests.

The tests write local screenshots and verification reports, which are excluded from Git. They use isolated browser contexts and do not change the saved language in your normal browser.

## Source files

| File | Purpose |
| --- | --- |
| `engine.js` | Heater and controller calculations |
| `app.js` | Controls, charts and calculation explanations |
| `index.html`, `styles.css` | Page layout and styling |
| `locale.js`, `locales/` | Language selection and translation source |
| `build.cjs` | Translation validation and offline bundle generation |
| `translations.js`, `pid-lab.html` | Generated files; rebuild after source changes |

Run `npm run build` and commit the generated files alongside source changes. The build checks that every added language covers all catalog entries and preserves numbered placeholders such as `{0}`.

GitHub Pages serves the `main` branch from its root directory. The `.nojekyll` file keeps publication as a plain static site; no build workflow or server is required.

## 日本語

[PID Lab を開く](https://mahlecube.github.io/pid-lab/)。初回は英語ですが、画面上部の言語設定から日本語へ切り替えられます。

仮想ヒーターを使い、P・PI・PID の応答、ゲインや積分時間、出力制限の影響を学ぶためのツールです。機器の性質と制御器の設定を別々に変更し、A/B の波形を比較できます。各制御周期の計算では、前回の積分値や計算出力も確認できます。

`pid-lab.html` をダウンロードすればオフラインでも使用できます。実機の調整値や安全性を保証するものではありません。
