/* Tutorial panel: a scrolling list of steps, each with a short looping clip recorded from the real editor
   (tutorial/make_tutorial.js). Clips load and play only while they are on screen. */
(function () {
  "use strict";
  const DIR = "/viewer/editor/tutorial/";
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
  const k = (s) => `<kbd>${s === "⌘" ? MOD : s}</kbd>`;       // Ctrl on Windows and Linux
  // clip: [file, width, height, optional caption]
  const chapters = (hosted) => [
    { title: "Getting started", note: "Open an image and find your way around.", steps: [
      { id: "open", nav: "Open an image", title: "Open an image",
        text: `Six practice images are loaded, each with a model's blue regions to correct (breast cancer tissue from the public BCSS dataset, and the output of a model trained on it). The arrows at the top left step through them. <b>Open</b> lists them all: click an image once to preview it, and again to open it. To switch to another library, click <b>Work on this</b> beside it.`,
        clips: [["01-open", 1280, 760]] },
      { id: "import", nav: "Add your own images", title: "Add your own images",
        text: `In <b>Open</b>, drop a folder (or a .zip file) onto <b>Upload folder</b>, or click it to choose one. Each image is paired with its model output by file name, for example <span class="mono">slide1_image.png</span> with <span class="mono">slide1_prob.tif</span> or <span class="mono">slide1_mask.png</span>. For just one image, use the <b>Single file</b> tab.`,
        tip: hosted ? `This is a shared demo server: please do not upload confidential or patient images.` : "",
        clips: [["21-import", 1280, 760]] },
      { id: "zoom", nav: "Zoom and move around", title: "Zoom and move around",
        text: `Pinch on a trackpad, or hold ${k("⌘")} and scroll, to zoom in where the pointer is. Drag empty space to move around. <b>Fit</b> shows the whole image again.`,
        tip: `The ${k("+")} and ${k("−")} buttons at the top zoom too.`,
        clips: [["02-zoom", 1280, 760]] },
      { id: "select", nav: "Select a region", title: "Select a region",
        text: `Click a region on the image, or click its name in the list. Orange nodes appear on its outline: that is the region you are working on. Press ${k("N")} to step to the next region. The list starts with the regions the model was least sure about.`,
        clips: [["03-select", 1042, 650]] },
    ] },
    { title: "Adjust an outline", note: `The Edit tool (the arrow, or press ${k("1")}). Select a region first.`, steps: [
      { id: "node", nav: "Move a node", title: "Move a node",
        text: `Drag an orange node to move that part of the outline.`, clips: [["04-node", 800, 500]] },
      { id: "bend", nav: "Bend the line", title: "Bend the line",
        text: `Drag the line between two nodes. It bends to follow the pointer, and the nodes stay where they are.`, clips: [["05-bend", 800, 500]] },
      { id: "addnode", nav: "Add or remove a node", title: "Add or remove a node",
        text: `Double-click the line to add a node where you need one, then drag it. Double-click a node to remove it and smooth out a kink.`, clips: [["06-add-remove-node", 800, 500]] },
      { id: "move", nav: "Move a whole region", title: "Move a whole region",
        text: `Drag from inside the region to slide all of it.`, clips: [["07-move-region", 800, 500]] },
    ] },
    { title: "Draw", note: `The Draw tool (the pencil, or press ${k("2")}).`, steps: [
      { id: "draw", nav: "Draw a new region", title: "Draw a new region",
        text: `Click the pencil or press ${k("2")}. Press, draw around the area, and finish where you started. The shape fills in when the loop closes.`, clips: [["08-draw", 800, 500]] },
      { id: "parts", nav: "Draw in several strokes", title: "Draw in several strokes",
        text: `You can let go part-way. Press the <b>orange end</b> to carry on, and finish on the <b>first node</b> to close the shape.`,
        tip: `${k("Enter")} closes the shape from wherever you are. ${k("Esc")} cancels it.`, clips: [["09-draw-in-parts", 800, 500]] },
      { id: "undraw", nav: "Fix a slip", title: "Fix a slip while drawing",
        text: `Keep the button down and drag back along your line: it un-draws. Then carry on in the right direction.`,
        tip: `After letting go, ${k("Delete")} removes the last piece of the line.`, clips: [["10-undraw", 800, 500]] },
      { id: "reroute", nav: "Extend or trim a region", title: "Extend or trim a region",
        text: `Start <b>on the outline</b> (an orange dot shows where), draw the new edge, and end back <b>on the same outline</b>. That stretch of the outline is replaced by your line.`,
        clips: [["11-extend", 800, 500, "Extend <span>· draw the new edge outside the region</span>"], ["12-trim", 800, 500, "Trim <span>· draw through the region; the smaller piece is cut off</span>"]] },
      { id: "split", nav: "Split a region", title: "Split a region",
        text: `Draw a line <b>right across</b> a region: start outside it and end outside it. The region splits in two. The pieces share the cut, so with the Edit tool, moving or bending it changes both at once.`,
        tip: `One line splits every region it goes right through.`, clips: [["22-split", 800, 500]] },
      { id: "hole", nav: "Cut a hole", title: "Cut a hole",
        text: `Draw a closed shape <b>inside</b> a region. It becomes a hole.`, clips: [["13-cut-hole", 800, 500]] },
      { id: "unhole", nav: "Remove a hole", title: "Remove a hole",
        text: `Switch to the Edit tool (${k("1")}). Click inside the hole so it turns orange, then press ${k("Delete")}. Only the hole goes; the region stays.`, clips: [["14-remove-hole", 800, 500]] },
    ] },
    { title: "Whole-region tools", note: "Quicker than redrawing when the model was nearly right, or completely wrong.", steps: [
      { id: "slider", nav: "Grow or shrink", title: "Grow or shrink a region",
        text: `Select a region with the Edit tool: a bar appears under the image. Drag its slider towards <b>Grow</b> or <b>Shrink</b>. The edge moves most where the model was unsure. <b>Reset</b> puts it back.`,
        tip: `The slider redraws the region from the model, so it replaces any changes you made to that region by hand. It is off for a region you drew, split or merged.`, clips: [["15-grow-shrink", 800, 500]] },
      { id: "reshape", nav: "Grow, shrink or band by a distance", title: "Grow, shrink or add a band by an exact distance",
        text: `Type a distance in the bar. <b>Grow</b> and <b>Shrink</b> move the whole edge evenly by that much, each time you click. <b>Band</b> adds a new region: a ring of that width around the outside.`,
        tip: `The distance is in pixels until you set the pixel size in the Measure panel; then it is in µm.`, clips: [["23-reshape", 800, 500]] },
      { id: "merge", nav: "Merge or subtract", title: "Merge two regions, or cut one out of another",
        text: `Select a region, click <b>Merge</b>, then click a region that touches or overlaps it: the two become one. <b>Subtract</b> works the same way and cuts the second region's area out of the first. <b>Fill holes</b> and <b>Smooth</b> tidy the selected region.`,
        clips: [["24-merge", 800, 500]] },
      { id: "delete", nav: "Delete a region", title: "Delete a region",
        text: `Select the region and press ${k("Delete")}, or click <b>Delete</b> at the bottom right.`, clips: [["16-delete", 800, 500]] },
      { id: "undo", nav: "Undo a mistake", title: "Undo a mistake",
        text: `Click the undo arrow at the top, or press ${k("⌘")} ${k("Z")}. Every change can be undone, one step at a time. The second arrow (${k("⇧")} ${k("⌘")} ${k("Z")}) redoes.`, clips: [["17-undo", 920, 575]] },
      { id: "display", nav: "Check your work", title: "Check your work",
        text: `<b>Fill opacity</b> fades the blue so you can see the tissue underneath. <b>Model's original outline</b> (${k("M")}) shows, as a dashed line, where the model first drew. <b>Probability heatmap</b> (${k("H")}) shows how sure the model was.`, clips: [["18-display", 800, 500]] },
    ] },
    { title: "Label and measure", note: "Say what each region is, and read off its size.", steps: [
      { id: "label", nav: "Label a region", title: "Say what a region is",
        text: `Click the tag or press ${k("3")}, then click a region and pick its class, or press its number while the menu is open. A coloured dot marks it. The same menu marks a region as <b>Unsure</b> and holds a note. Click the class again to take it off.`,
        tip: `Double-click a region's name in the list to rename it. <b>Edit classes</b> changes the list for the library; a class set to be left out of measurements gets a dashed outline.`, clips: [["25-label", 800, 500]] },
      { id: "ruler", nav: "Measure with the ruler", title: "Measure with the ruler",
        text: `Click the ruler or press ${k("4")}. <b>Drag</b> for a straight distance. <b>Click a region</b> for its longest diameter, then <b>another region</b> for the smallest gap between them. <b>Click two points on one outline</b> for the length along it, both ways round.`,
        tip: `Click empty space, or press ${k("Esc")}, to clear a measurement. Measuring one region also shows it in the Measure panel.`, clips: [["26-ruler", 800, 500]] },
      { id: "measure", nav: "The Measure panel", title: "The Measure panel",
        text: `<b>Measure</b>, on the right, shows the selected region's area, perimeter, longest diameter and circularity. The table gives each class's area, its share of all the regions and its share of the image, with a total. Type the <b>pixel size</b> to read everything in µm. <b>Download CSV</b> saves one table for the whole library.`,
        tip: `Hold ${k("X")} to hide the regions and see the bare tissue.`, clips: [["27-measure", 800, 500]] },
    ] },
    { title: "Finish", note: "Your work is saved by itself as you go.", steps: [
      { id: "done", nav: "Done, next image", title: "Mark done and go to the next image",
        text: `Click <b>Done</b> (${k("D")}) when an image is finished. The arrows at the top left (or ${k("←")} and ${k("→")}) go to the previous and next image.`, clips: [["19-done-next", 1280, 760]] },
      { id: "export", nav: "Export", title: "Export",
        text: hosted
          ? `Click <b>Export</b>. Choose this image or all of them, and tick the file types you want (ImageJ, QuPath, plain masks). They download as one .zip.`
          : `Click <b>Export</b>. Choose this image or the whole library, the folder to save in, and which files you want. The bar shows progress, and a button opens the folder when it is done.`,
        clips: [[hosted ? "20-export-hosted" : "20-export", 980, 612]] },
    ] },
  ];

  const $ = (id) => document.getElementById(id);
  const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>', PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z"/></svg>';
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let built = false, watcher = null, spy = null;

  function build() {
    built = true;
    let n = 0, nav = "", main = "";
    for (const ch of chapters(document.documentElement.classList.contains("hosted"))) {
      nav += `<h5>${ch.title}</h5>`;
      main += `<div class="tut-chap">${ch.title}<span>${ch.note}</span></div>`;
      for (const s of ch.steps) {
        n++;
        nav += `<button type="button" data-go="t-${s.id}"><i>${n}</i><span>${s.nav}</span></button>`;
        main += `<section class="tstep" id="t-${s.id}"><div class="tstep-h"><span class="tnum">${n}</span><h4>${s.title}</h4></div><p>${s.text}</p>${s.tip ? `<p class="tip">${s.tip}</p>` : ""}` +
          s.clips.map(([f, w, h, cap]) => `<div class="tclip">${cap ? `<div class="cap">${cap}</div>` : ""}<div class="tvid" style="aspect-ratio:${w}/${h};max-width:${Math.round(Math.min(760, w))}px">
            <video muted loop playsinline preload="none" poster="${DIR}${f}.jpg" data-src="${DIR}${f}.mp4" aria-label="${s.title}"></video><span class="pp">${PAUSE}</span></div></div>`).join("") + `</section>`;
      }
    }
    main += `<div class="tut-end">That is everything. The <b>Shortcuts</b> button at the top lists every key on one page, and the bar along the bottom of the editor always says what the current tool can do.</div>`;
    $("tutNav").innerHTML = nav; $("tutMain").innerHTML = main;
    $("tutNav").querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => $(b.dataset.go).scrollIntoView({ behavior: "smooth", block: "start" })));

    // play a clip only while most of it is on screen
    watcher = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = e.target, box = v.parentElement;
        if (e.isIntersecting && e.intersectionRatio >= 0.55) {
          if (!v.src) v.src = v.dataset.src;
          if (!box.dataset.stopped && !still) v.play().catch(() => {});
        } else if (!v.paused) v.pause();
      }
    }, { root: $("tutMain"), threshold: [0, 0.55, 1] });
    $("tutMain").querySelectorAll(".tvid").forEach((box) => {
      const v = box.querySelector("video"), pp = box.querySelector(".pp");
      const show = () => { box.classList.toggle("paused", v.paused); pp.innerHTML = v.paused ? PLAY : PAUSE; };
      v.addEventListener("play", show); v.addEventListener("pause", show);
      box.onclick = () => { if (!v.src) v.src = v.dataset.src; if (v.paused) { delete box.dataset.stopped; v.play().catch(() => {}); } else { box.dataset.stopped = "1"; v.pause(); } };
      if (still) { box.dataset.stopped = "1"; box.classList.add("paused"); pp.innerHTML = PLAY; }
      watcher.observe(v);
    });
    // highlight the step being read
    spy = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) {
        $("tutNav").querySelectorAll("button").forEach((b) => { const on = b.dataset.go === e.target.id; b.classList.toggle("on", on); if (on) b.scrollIntoView({ block: "nearest" }); });
      }
    }, { root: $("tutMain"), rootMargin: "-12% 0px -72% 0px" });
    $("tutMain").querySelectorAll(".tstep").forEach((s) => spy.observe(s));
  }

  window.Tutorial = {
    open(step) {
      if (!built) build();
      $("tutModal").classList.add("show");
      if (step && $("t-" + step)) $("t-" + step).scrollIntoView({ block: "start" });
    },
    pause() { if (built && !$("tutModal").classList.contains("show")) $("tutMain").querySelectorAll("video").forEach((v) => v.pause()); },
  };
})();
