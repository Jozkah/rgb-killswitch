# rgb-killswitch

One command, or one Stream Deck key, that turns off all the RGB lighting in your PC and brings it back.

It talks to the lighting hardware directly, so it needs **no vendor app running** (no Armoury Crate, Synapse, MSI Center or OpenRGB) and **no configuration**. It looks at what is plugged in, drives what it recognises and skips the rest.

```
rgb off          # everything dark
rgb on           # everything back
rgb toggle       # flip it
rgb off case     # only the inside of the PC, leave keyboard and mouse lit
```

## What it controls

| Family | What | How |
| --- | --- | --- |
| ASUS Aura motherboards | Onboard LEDs and addressable (ARGB) headers, including fans and anything synced to them | USB, ASUS's Aura controller |
| Corsair iCUE | Everything iCUE can see: RAM, fan controllers, coolers, keyboards, mice | Corsair's official iCUE SDK |
| Razer | Keyboards, mice, mousemats and other devices that answer Razer's lighting protocol | USB, brightness set to 0 |
| MSI RTX graphics cards | The card's own lighting | NVIDIA driver I2C interface |

"Case" means the motherboard, GPU, RAM, fans and other internal Corsair parts. "All" adds keyboard, mouse, mousepad and headset.

### Tested on

| Hardware | Result |
| --- | --- |
| ASUS ROG STRIX B650E-F GAMING WIFI | works |
| Corsair Vengeance RGB DDR5, Commander CORE (pump and fans) | works |
| Corsair Commander PRO | not supported: iCUE's SDK reports no lights on it |
| Razer BlackWidow Elite, Naga V3 Pro, Firefly V2 Pro | works |
| MSI GeForce RTX 5080 SUPRIM | works (this one carries another vendor's BIOS, so it needs the [override](#unusual-hardware)) |

Other boards and devices that use the same protocols *should* work, but I have only been able to test the hardware above. If something does not turn off, please open an issue with the output of `rgb status`.

### What it cannot do (yet)

This is not a universal driver. Every vendor speaks its own protocol, so anything not listed above is left alone: Gigabyte, MSI and other motherboards, Logitech, SteelSeries, NZXT, Lian Li, AMD graphics cards, and most non-MSI graphics cards. [OpenRGB](https://openrgb.org) supports far more hardware; this project is for people who want a tiny switch and nothing else running.

Windows 10/11 (x64) only for now. The ASUS and Razer code uses cross-platform USB access and may work elsewhere, but is untested there.

## Getting started

You need [Node.js](https://nodejs.org) 20 or newer.

```
git clone https://github.com/Jozkah/rgb-killswitch
cd rgb-killswitch
npm install
.gb.cmd toggle
```

`npm install` also downloads Corsair's iCUE SDK from Corsair's official release page (it is not bundled here). If you use Corsair gear, turn on **Settings, Enable SDK** in iCUE.

Handy shortcuts:

- Put the folder on your `PATH` and `rgb toggle` works from anywhere.
- Bind `rgb.cmd toggle` to a hotkey, a desktop shortcut, or a Task Scheduler job to turn the lights off at night.

### What "on" does

Some of this hardware cannot report what it was showing, so "on" cannot always restore your exact effect:

- **iCUE** devices (RAM and so on) go back to your iCUE profile exactly.
- **Commander CORE** (pump and fans) is switched over USB because iCUE's SDK cannot reach its lights. It returns to the hub's own built-in lighting, not necessarily your iCUE profile.
- **Razer** devices go back to their previous brightness (and keep whatever effect they had). A brightness below 10% is treated as a glitch and restored to full.
- **Motherboard** lighting comes back as a rainbow, or a fixed color: `rgb on --color ff5500`.
- **MSI graphics cards** come back as Rainbow Wave.

### The background process

iCUE only keeps lighting changes while a program stays connected. So `rgb off` leaves a tiny background process running that holds the Corsair session; `rgb on` stops it. If iCUE restarts while your lights are off, it re-applies the blackout.

## Stream Deck plugin

```
npm run streamdeck:install
```

Restart Stream Deck and find **RGB Kill Switch** in the action list. Three keys:

- **Toggle case RGB**: motherboard, GPU, RAM and fans.
- **Toggle case + peripherals RGB**: everything. Turns everything off, or everything on if it is already all off.
- **Auto-off when idle**: when armed, everything goes dark after a set number of idle minutes (default 5, set in the key's settings) and comes back on the first keyboard or mouse input. Anything you switched off by hand before you left stays off.

The keys show the real state and share it with each other. Stream Deck 7.1 or newer is required.

## Safety

- Probing only sends read and query commands. Nothing is written to a device until it has been identified.
- A graphics card is only touched if it reports an MSI subsystem ID **and** answers on MSI's lighting chip address. A card that does neither is skipped.
- Razer brightness changes are saved to the device (some keyboards ignore them otherwise), so if the tool is killed while lights are off, run `rgb on` to restore them.

### Unusual hardware

Nothing needs configuring, but one override exists. An MSI card flashed with another vendor's BIOS reports the wrong IDs and is skipped. If that is you, create `%LOCALAPPDATA%\rgb-killswitch\overrides.json`:

```json
{ "gpu": "msi" }
```

or set the environment variable `RGB_KILLSWITCH_GPU=msi`.

## Development

```
npm run typecheck
npm run build
RGB_KILLSWITCH_DEBUG=1 rgb off     # the background process logs to %LOCALAPPDATA%\rgb-killswitch\holder.log
```

Layout: `src/core` holds one module per hardware family plus a runner that drives them in parallel threads; `src/cli` is the command line tool; `src/streamdeck` is the plugin.

## Credits and license

The USB and I2C lighting protocols used here come from the reverse-engineering work of the [OpenRGB](https://gitlab.com/CalcProgrammer1/OpenRGB) project, and this project is released under the same terms: [GPL-2.0-or-later](LICENSE). Corsair's iCUE SDK is downloaded from Corsair under its own terms.

This project is not affiliated with ASUS, Corsair, Razer, MSI or NVIDIA. Writing to hardware you do not own, or with buggy firmware, can misbehave; you use it at your own risk.
