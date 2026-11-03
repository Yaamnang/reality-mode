# GODMODE gestures

Every hand gesture the app understands.

**Your right hand chooses, your left hand changes.** Both hands can be in view at once. Each hand only does its own gestures: a fist from the right hand does nothing.

All gestures work **from behind the hand** (back of the hand toward the camera), the way a POV camera sees it. They are read from the 3D shape of the fingers, not from how the hand looks.

## Reality Shift

Five moves, each held still on purpose. A hand moving around, resting open or touching something does nothing, because every hold starts over if the hand moves. Gestures act on the **selected** object: the one with the green highlight and the blue card in the tray. A filling ring around the object shows what's about to happen; let go before it fills to cancel.

### Right hand: choose

| Gesture | How | What it does |
|---|---|---|
| **Point + hold still** | One finger straight, the other three folded. Hold still for 1.2 s. The dashed line runs on across the view like a laser, so you can point at something out of reach; it stops on what it found. | On a new object: **locks** it. A blue highlight and a filling ring appear, then it turns green and joins the tray as the selected object. On an object already in the tray: **selects** it, whether you point at it where it is now or at the spot where it really was. |
| **Open hand held 3 s** | All four fingers straight, hand still. Purple ring. | **Transmute.** The first time, Meta suggests 4 things that could stand in the object's place and makes all of them; whichever finishes first shows first. The suggestions are asked for 1 s into the hold, and letting go before 3 s cancels them. Each hold after that goes to the next one: 1 → 2 → 3 → 4 → real object → 1. Lower or close the hand between holds. A moved object changes where it is now. |
| **Twist the open hand** | Turn it like a knob, about 40° per step. Only after a transmute has started. | Switches between those versions instantly: clockwise = next, counterclockwise = back. |

### Left hand: change

| Gesture | How | What it does |
|---|---|---|
| **Fist held 2 s** | Hand still. Blue ring. | **Grabs** the selected object. Move the fist to drag it, even while the camera turns to another part of the room. You can also pick up an object you moved before. A transmuted object moves as it is now; if Meta's still drawing it, wait for it to finish. |
| **Open the hand (while dragging)** | Open it for at least 0.25 s. | **Drops** the object. |
| **Thumbs down held 1 s** | Fist with the thumb pointing down, fingers tightly folded, hand still. Red ring. | **Erases** the selected object in the Virtual view. Meta's Muse Image fills the spot. |

### Both hands

| Gesture | How | What it does |
|---|---|---|
| **Both fists held 2 s** | Hands still. Red ring around the selected object. | **Puts the selected object back:** every change to it is undone, and it leaves the tray. Other objects stay as they are. Doesn't work while you're dragging, so drop it first. |

Turn the camera slowly: a very fast swing can lose its place for a moment until it recognises the view again. Keep the phone at about the same spot and distance, since the tracking handles turning, not walking around.

Without gestures:

- **Tap** an object in the video: locks it, or selects it if it's already in the tray. Useful as a backup during demos.
- **Transmute box** (Reality Shift card): type a command such as "make it gold" or "turn it into a cactus" to change the selected object.
- **Put object back** button: returns the selected object to how it really is, in its original place, and takes it out of the tray. Same as both fists.
- **Reset all** button: puts every object back.

### Switched off

Three-finger swipe + ✌ on the tray, both open hands for the inventory, and left open hand to remove. They're still in the code: `EXTRA_GESTURES` in `web/src/hudTray.ts` brings them back.

## Time Knob

Either hand works here: left and right have no separate jobs in this tab.

| Gesture | How | What it does |
|---|---|---|
| **Point + hold still** | One finger straight, the other three folded. Hold still for 1.2 s (2 s if an object is already locked). Works from across the view, like a laser. | **Locks** the object. Three Muse Spark agents say what it is, a judge decides, and Muse Image prepares its whole timeline right away (~40-60 s). The object's border stays lit, and a card top left shows what the judge decided: the name, how sure it is, what kind of thing it is and where it ends up (like "Fruit · Biodegradable" or "Electronics · Toxic waste"). Move your hand off the object after locking. Locking another object replaces it. |
| **Closed fist, moved around the object** | Hold a closed fist still for 1 s, then draw around it. Finish by opening your hand, holding still for 1 s, or coming back to where you started. | **Draws a border** around something too big to lock by pointing. A straight line closes the rest, and it's analyzed like a locked object (about 5 cents). Then move your hand away. |
| **Open hand** | All four fingers straight. | Shows the **magic circle** on your hand, once an object is locked. If you twist to a moment that isn't ready yet, it appears by itself as soon as it is. |
| **Twist the open hand left** | Counterclockwise on screen, about 40° per step. | **Back in time.** The card changes to describe what's on screen. A phone: exploded view, then raw materials. An apple: green apple, then blossom. |
| **Twist the open hand right** | Clockwise on screen, about 40° per step. | **Forward in time.** Things that grow or decay only: an apple bruises, then rots. Made things have no future stage, and it says so. |

Without gestures:

- **Tap** an object in the video: locks it.
- **← → keys**: move the knob, as a backup for the twist.
- **Start over** button (Time Knob card): back to the live camera, nothing locked.

## Planned (not built yet)

- **Voice commands**, for example "make it gold" or "erase it". The gesture to start listening isn't decided yet.

## Tips

- Each hand's label (Left / Right) is shown next to it in the view. If it's wrong, that hand's gestures won't work: say so in the log.
- Thumbs down is the least reliable from behind: a finger pointing down at the desk can look like a thumb. Fold your fingers tightly.
- The **Activity** log (and the `npm run dev` terminal) shows every gesture change, which helps when something isn't recognized.
