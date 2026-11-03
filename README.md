# GODMODE

> See before you act.

**Demo video (3 min):** [watch on Google Drive](https://drive.google.com/file/d/1L26FyVgISnNXGjKVbghV-fll7Kz7CfDW/view?usp=sharing)

GODMODE is an AI layer over the real world, controlled with your bare hands. Point a camera at a real object and twist your hand to see its past and its future, or move and change the things in your room before you lift anything. It runs on a laptop webcam or a phone. It's a prototype of what Ray-Ban Meta glasses or Meta Quest could do, where you look at a thing and the answer appears on it; nothing in this repo runs on those devices yet.

Built solo in Thimphu, Bhutan, for the Meta Global AI Developer Hackathon 2026 (Indie Developer track, **Build for Your World**).

## The problem

Every day we make decisions about physical things from one snapshot: what they look like right now. We can't see how an avocado will change, whether the gadget we're about to bin counts as toxic waste, how a sacred thangka was made or how it should be handled, or how a room will look before we drag the furniture around. So we guess, and guessing costs food, money, effort, and sometimes respect for things that matter.

Where I live, that last one is real. In Bhutan a Buddhist thangka, statue or prayer flag is never put in the bin; it is burned respectfully. I wrote that rule into GODMODE's judge (`server/timeknob.py`): point it at a thangka and it says **Sacred item · Never throw, burn**, and it only shows how the painting was made, never the painting torn or decaying.

## What it does

For this demo, GODMODE is split into two features. Every past and future stage is a picture Muse Image draws on the real object: a preview, not a photo, and not a prediction with dates.

### Time Knob: know what you're holding

Point at an object and twist your hand to travel through its life.

- **Avocado:** back to blossoms and unripe fruit on the branch, forward to overripe and rotten.
- **AirPods case:** back to an illustrated exploded view, then raw materials. Tagged **Electronics · Toxic waste**, so it doesn't go in the normal bin.
- **Thangka:** back to the bare canvas with its pencil sketch, then the mineral pigments. Tagged **Sacred item · Never throw, burn**.

When something has no honest future, GODMODE says so instead of inventing one: turn an AirPods case forward and it shows *"No future: made things don't age on their own."*

### Reality Shift: change your space before you lift anything

Moving house? See where things go, and what they could be, before you carry anything. Lock onto a real object by pointing at it, then change it with gestures. The Real and Virtual views sit side by side, both live.

- **Move:** grab an object with your fist and drop it somewhere else. Muse Image fills the spot it left.
- **Erase:** make it disappear with a thumbs down.
- **Transmute:** hold your hand open. Muse Spark suggests 4 things that could stand in its place and Muse Image draws them all. Twist your hand like a knob to switch between them instantly. You can also type a command, like "make it gold".
- **Any order:** a transmuted object can be moved, and a moved object can be transmuted where it now stands.

### How the Time Knob works

Lock onto an object and three Muse Spark agents examine it: one studies the details, one the surroundings, one the material. A fourth acts as judge and decides what it is, what kind of thing it is and where it ends up, such as "Fruit · Biodegradable" or "Electronics · Toxic waste". It then writes the object's timeline, and Muse Image draws every stage.

Muse Spark then checks every picture Muse Image draws against the stage it was meant to show, and redraws it if it's wrong. Made things get no future stages, and sacred items only get the stages of how they were made.

Open your hand to bring up a magic circle on your palm, then twist it to travel through time.

## How Meta's models are used

| Model | What it does here |
|---|---|
| **Muse Spark 1.3** | Names locked objects, suggests replacements, runs the Time Knob's three agents and judge, checks each picture Muse Image draws, and rewrites a description when one is refused or drawn wrong |
| **Muse Image 1.0** | Fills the gap when an object is erased or moved, transmutes objects, and draws every Time Knob stage |
| **SAM 3.1** | Finds the Time Knob's object again by name, so its pictures stay in place when the camera moves |

Meta's models only ever see single snapshots, never every frame. All the real-time work runs in the browser:

- **Hands:** MediaPipe (Google) reads hand gestures and finds object outlines.
- **Camera tracking:** custom code in `sceneTracker.ts` and `pinTracker.ts` keeps edits pinned to the room as the camera turns.

The API key stays on the Python server and never reaches the browser.

**Typical times and costs on a real frame:**

| Action | Time | Cost |
|---|---|---|
| Erase or move an object | 12-22 s | about 1 cent |
| Transmute, 4 versions | first after about 15 s, all after about 25 s | about 4-5 cents |
| Time Knob, one object | 40-60 s to prepare its whole timeline | about 3-5 cents |

The app stays live during these waits. An erase shows an instant rough fill, then Meta's picture fades in over it.

## Benchmarks

Measured on real devices and real Meta calls, except tracking accuracy, which is simulated so the true position is known. Full tables and methods are in [BENCHMARKS.md](BENCHMARKS.md).

| What | Result |
|---|---|
| Laptop, 1280x720 webcam | 92 screen frames per second, keeps up with the camera's 30 |
| Hand model per frame | 11 ms on the laptop, 30 ms on the phone |
| Phone, typical use | 14 screen frames per second; about 43 at its fastest |
| Muse Image fill | median 13.3 s across 16 real runs |
| Time Knob picture position, hand-held camera (simulated) | 1.5 px median error, 4.3 px worst, on a 1280-wide frame |
| Slide-only tracker on the same move, still used by Reality Shift | 45 px median error |

## Gestures

Every gesture works from behind the hand, the way a camera worn on your head would see it. Each one has to be held still, so a resting hand or touching something doesn't set it off.

**Reality Shift:**

| Hand | Gesture | Action |
|---|---|---|
| Right | Point, hold still 1.2 s (works across the view, like a laser) | Lock or select an object |
| Right | Open hand, hold 3 s, then twist | Transmute, then switch versions |
| Left | Fist, hold 2 s, move, then open | Grab, drag, drop |
| Left | Thumbs down, hold 1 s | Erase |
| Both | Both fists, hold 2 s | Put the selected object back |

**Time Knob**, either hand:

| Gesture | Action |
|---|---|
| Point, hold still 1.2 s | Lock an object |
| Fist held still 1 s, then draw around it | Lock something too big to point at |
| Open hand, then twist | Move through time |

The full list, with mouse and keyboard backups, is in [GESTURES.md](GESTURES.md).

## Run it

You need Python, Node.js, a webcam and a Meta Model API key. The commands below are for Windows.

Create a file called `.env` in the project's top folder:

```
MODEL_API_KEY=your-key-here
```

**1. Backend**, in one terminal, from `server/`:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000 --timeout-graceful-shutdown 2
```

`python check_meta.py` makes one tiny paid call, to check that your key works.

**2. Frontend**, in a second terminal, from `web/`:

```bash
npm install
npm run dev
```

Open https://localhost:5173 and click **Start camera**. The first time, the browser warns about the certificate, because the dev server makes its own for HTTPS: click Advanced, then Proceed.

**Phone:** click **Connect phone** and scan the QR code. The phone must be on the same Wi-Fi as the laptop, or on the laptop's Mobile Hotspot.

## Project layout

```
web/src/
  main.ts           page, tabs and the frame loop
  realityShift.ts   Reality Shift: the object tray, gestures and the changes to objects
  timeKnob.ts       Time Knob: locking, timelines and showing each stage
  gestures.ts       hand tracking and reading gestures from finger shapes
  highlight.ts      finding an object's outline from a point
  virtualView.ts    the Virtual view: fills, cut-outs and pasting Meta's pictures
  sceneTracker.ts   how far the camera has turned
  pinTracker.ts     keeps a saved view lined up with the live camera
  dial.ts           reading the hand twist
  magicCircle.ts    the circle on your palm
  hudTray.ts        the object tray drawn into the view
  handLayer.ts      keeps your hands in front of edits
server/
  main.py           the API the browser calls
  remove.py         Muse Spark and Muse Image calls for Reality Shift
  timeknob.py       the Time Knob's agents, judge and stages
  outline.py        SAM 3.1
  spend.py          local estimate of Meta credit spent
tools/replay/       reruns the models on saved camera frames, for debugging
```

## Known limits

- **Big objects need clear outlines.** Anything over 12% of the view is only accepted, up to 30%, if it's solid, smooth and clearly outlined, because larger results are usually the desk or floor. An outline can take in something touching the object. Time Knob's fist-drawn border is the way to pick anything else.
- **Pointing from far away is less exact.** The pointing line runs across the whole view, so a small wobble of the finger moves it a lot at a distance.
- **Turning, not walking.** Tracking handles a camera that turns or tilts. Reality Shift's edits don't change size or perspective if you walk closer. Very fast swings can lose its place for a moment.
- **Pictures are stills.** The picture Meta drew is stretched to follow the camera, so a tall object seen from a new side looks like a sticker.
- **Hands in front are approximate.** They're drawn from the hand model's landmarks, and the forearm is a straight-line guess.
- **Meta's filter can refuse a wording.** The Time Knob rewrites and retries. Elsewhere that edit fails and the app says so.
- **Testing is partial.** Reality Shift's main gestures have been used on a real webcam. Much of the rest was tested with a fake camera and simulated hands, including turning the camera while editing and Time Knob's stay-in-place behaviour.

## Built during the event

The hackathon ran from Oct 26 to Nov 4, 2026. The project folders and tool installs date from Oct 24. Every source file under `web/src`, `server` and `tools` was created on Oct 28 or later.

| Date | What was built |
|---|---|
| Oct 28-29 | Camera, phone access over HTTPS, hand tracking and gesture reading, the replay tool for debugging |
| Oct 31 | Object outlines from pointing, the first Meta calls, erase with Muse Image, moving objects, the object tray, the Real and Virtual split view, the credit estimate |
| Nov 1 | Transmute, the four-version dial and the hand twist |
| Nov 2 | Time Knob: the agents and judge, drawing stages, the magic circle; gestures read from behind the hand |
| Nov 3 | Camera tracker, left and right hand roles, keeping pictures pinned to the room as the camera moves |
| Nov 4 | Time Knob staying in place when the camera moves, drawing a border with a fist, fewer and steadier gestures, hands in front of edits, moving and transmuting in either order |

**Third-party parts:** MediaPipe's runtime and its hand and segmentation models are included in `web/public/` so the live part runs without a network connection. Meta's models are called through Meta's API.
