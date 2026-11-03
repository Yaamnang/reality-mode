# Benchmarks

Measured on Nov 4, 2026, from the app's own logs and from test runs on the code in this repo. Each table says how its numbers were measured. These are one person's measurements on one laptop and one phone, not a lab study.

## Live speed on real devices

The app logs a speed line every 5 s while the camera runs. These are the medians of those lines, with hand tracking on.

| | Laptop, webcam at 1280x720 | Phone, camera at 720x1280 |
|---|---|---|
| Samples (5 s each) | 509 | 197 |
| Screen frames per second | 92 | 14 |
| Camera frames processed per second | 30 | 13 |
| Hand model, per frame | 11 ms (90th percentile 17 ms) | 30 ms (90th percentile 53 ms) |
| Rest of the app, per screen frame | 4 ms (90th percentile 9 ms) | 36 ms (90th percentile 115 ms) |

The laptop keeps up with its 30 frames per second camera. The phone is much slower once an object is being followed. In the phone's fastest moments (22 samples at 25 or more screen frames per second) the camera ran at 27 frames per second and the hand model took 26 ms. Laptop and phone numbers mix both features and all kinds of use, and some of the laptop samples may come from automated test runs.

On the laptop, finding an object's outline from a point took a median of 25 ms per look (64 logged looks, range 20-145 ms). The room tracker took about 8 ms per camera frame in a real session.

## Meta model response times

Real Meta API calls on real camera frames.

| Action | Measured | Runs |
|---|---|---|
| Erase or move: Muse Image fills the gap | median 13.3 s, range 11.0-23.4 s | 16 |
| Transmute: first of 4 versions | 15.5 s after the hold, in one timed run | 1 |
| Transmute: all 4 versions | 26.7 s after the hold, in one timed run | 1 |
| Time Knob: lock to whole timeline ready | 38 s, 52 s and 71 s | 3 |

The 71 s run had a picture refused by Meta's filter, which was rewritten and retried. Nothing waits on Meta during these times: the app stays live and pictures appear as they arrive.

## Tracking accuracy

Time Knob's pictures stay on the object by tracking a saved view of the room (`pinTracker.ts`). To test that, a real desk photo was moved through simulated camera motion, so the true position is known at every frame, with noise added. Error is the distance of the picture's worst corner from where it should be, in pixels of a 1280-wide frame. "Shown" is the number of frames the picture was displayed; it hides when tracking is lost, so errors are only counted while it's visible.

| Camera move | Median error | 95th percentile | Worst | Shown |
|---|---|---|---|---|
| Still | 0.1 px | 0.1 px | 0.1 px | 59 of 59 |
| Pan sideways | 1.5 px | 2.7 px | 3.2 px | 149 of 149 |
| Hand-held: pan, tilt, roll 8°, shake | 1.5 px | 2.9 px | 4.3 px | 209 of 209 |
| Stepping 1.6x closer and back | 2.8 px | 3.6 px | 4.2 px | 179 of 179 |
| Stepping while turning | 1.8 px | 3.1 px | 5.1 px | 209 of 209 |
| Exposure drifting ±25% | 1.6 px | 2.9 px | 4.7 px | 119 of 119 |
| A hand passing over | 2.0 px | 3.1 px | 4.2 px | 119 of 119 |
| Leaving the view and returning | 2.0 px | 13.3 px | 19.2 px | 239 of 239 |
| Floor and wall moving differently | 2.7 px | 13.0 px | 20.4 px | 179 of 179 |
| Fast swing with blur | 1.9 px | 4.4 px | 49.2 px | 89 of 89 |
| Blocked for 1 s while moving | 2.3 px | 36.5 px | 45.9 px | 68 of 149 |
| A big person crossing, camera turning | 2.0 px | 32.1 px | 67.5 px | 149 of 149 |
| Whipped away 2 s, stepped closer, back | 0.1 px | 0.1 px | 82.9 px | 54 of 117 |

For comparison, the simpler slide-only tracker scored a median of 45 px on the hand-held move and 202 px on stepping closer. **Reality Shift still uses that slide-only tracker**, which is why it handles turning but not walking. Real camera parallax, rolling shutter and motion blur aren't fully captured by a simulation.

## Telling objects from background

The outline rules were replayed on 233 saved frames from a real room, at the point the app looked at when each frame was saved. The changes for big, low-contrast objects newly accepted 11 frames, all from scenes of a large bag and a chest of drawers. An earlier, looser version also accepted desk and floor patches, so it was tightened until they were rejected again. The frames were spot-checked by eye, not all labelled by hand, so this isn't a precision score.

## Gesture checks

These ran on the real clock or a simulated clock with simulated hands, so they test the logic, not how well a real hand is read.

| Hand | Result |
|---|---|
| Left open hand for 3 s, both hands open for 2 s | Nothing happens |
| Left fist moving around for 3 s | Nothing happens |
| Left fist held still for 2.2 s | Grabs |
| Thumbs down for 0.5 s | Nothing happens |
| Thumbs down held for 1.2 s | Erases |
| Both fists for 1.5 s, or moving | Nothing happens |
| Both fists held still for 2.2 s | Puts back only the selected object |
| Pointing and swaying for 5 s | Doesn't lock |
| Pointing, held still, from nearby | Locks in 1.3 s |
| Pointing, held still, from across the room | Locks in 1.5-1.9 s |

## Cost

Estimates from Meta's token usage and per-image prices, tracked locally by `server/spend.py`.

| Action | Cost |
|---|---|
| Erase or move an object | about 1 cent |
| Transmute, 4 versions | about 4-5 cents |
| Time Knob, one object | about 3-5 cents |
