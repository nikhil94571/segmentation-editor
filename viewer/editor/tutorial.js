/* Tutorial panel: a scrolling list of steps, each with a short looping clip recorded from the real editor
   (tutorial/make_tutorial.js). Clips load and play only while they are on screen. */
(function () {
  "use strict";
  const DIR = "/viewer/editor/tutorial/";
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
  const k = (s) => `<kbd>${s === "⌘" ? MOD : s}</kbd>`;       // Ctrl on Windows and Linux
  // clip: [file, width, height, optional caption]
  const CHAPTERS = [
    { title: "Getting started", note: "Open your images and find your way around.", steps: [
      { id: "open", nav: "Open your images", title: "Open your images",
        text: `Click <b>Open…</b>, then <b>Work on this</b> beside a library. To choose a different image later, click <b>Open…</b> again: one click on an image shows a preview, a second click opens it.`,
        clips: [["01-open", 1280, 760]] },
      { id: "import", nav: "Add your own images", title: "Add your own images",
        text: `In <b>Open…</b>, drop a folder (or a .zip file) onto <b>Upload folder</b>, or click it to choose one. Each image is paired with its model output by file name. For just one image, use the <b>Single file</b> tab.`,
        clips: [["21-import", 1280, 760]] },
      { id: "zoom", nav: "Zoom and move around", title: "Zoom and move around",
        text: `Pinch on a trackpad, or hold ${k("⌘")} and scroll, to zoom in where the pointer is. Drag empty space to move around. <b>Fit</b> shows the whole image again.`,
        tip: `The ${k("+")} and ${k("−")} buttons at the top zoom too.`,
        clips: [["02-zoom", 1280, 760]] },
      { id: "select", nav: "Select a region", title: "Select a region",
        text: `Click a region on the image, or click its name in the list. Orange nodes appear on its outline: that is the region you are working on. Press ${k("N")} to step to the next region. The list starts with the regions the model was least sure about.`,
        clips: [["03-select", 1042, 650]] },
    ] },
    { title: "Adjust an outline", note: `The Edit tool (the arrow, or press ${k("V")}). Select a region first.`, steps: [
      { id: "node", nav: "Move a node", title: "Move a node",
        text: `Drag an orange node to move that part of the outline.`, clips: [["04-node", 800, 500]] },
      { id: "bend", nav: "Bend the line", title: "Bend the line",
        text: `Drag the line between two nodes. It bends to follow the pointer, and the nodes stay where they are.`, clips: [["05-bend", 800, 500]] },
      { id: "addnode", nav: "Add or remove a node", title: "Add or remove a node",
        text: `Double-click the line to add a node where you need one, then drag it. Double-click a node to remove it and smooth out a kink.`, clips: [["06-add-remove-node", 800, 500]] },
      { id: "move", nav: "Move a whole region", title: "Move a whole region",
        text: `Drag from inside the region to slide all of it.`, clips: [["07-move-region", 800, 500]] },
    ] },
    { title: "Draw", note: `The Draw tool (the pencil, or press ${k("P")}).`, steps: [
      { id: "draw", nav: "Draw a new region", title: "Draw a new region",
        text: `Click the pencil or press ${k("P")}. Press, draw around the area, and finish where you started. The shape fills in when the loop closes.`, clips: [["08-draw", 800, 500]] },
      { id: "parts", nav: "Draw in several strokes", title: "Draw in several strokes",
        text: `You can let go part-way. Press the <b>orange end</b> to carry on, and finish on the <b>first node</b> to close the shape.`,
        tip: `${k("Enter")} closes the shape from wherever you are. ${k("Esc")} cancels it.`, clips: [["09-draw-in-parts", 800, 500]] },
      { id: "undraw", nav: "Fix a slip", title: "Fix a slip while drawing",
        text: `Keep the button down and drag back along your line: it un-draws. Then carry on in the right direction.`,
        tip: `After letting go, ${k("Delete")} removes the last piece of the line.`, clips: [["10-undraw", 800, 500]] },
      { id: "reroute", nav: "Extend or trim a region", title: "Extend or trim a region",
        text: `Start <b>on the outline</b> (an orange dot shows where), draw the new edge, and end back <b>on the same outline</b>. That stretch of the outline is replaced by your line.`,
        clips: [["11-extend", 800, 500, "Extend <span>· draw the new edge outside the region</span>"], ["12-trim", 800, 500, "Trim <span>· draw through the region; the smaller piece is cut off</span>"]] },
      { id: "hole", nav: "Cut a hole", title: "Cut a hole",
        text: `Draw a closed shape <b>inside</b> a region. It becomes a hole.`, clips: [["13-cut-hole", 800, 500]] },
      { id: "unhole", nav: "Remove a hole", title: "Remove a hole",
        text: `Switch to the Edit tool (${k("V")}). Click inside the hole so it turns orange, then press ${k("Delete")}. Only the hole goes; the region stays.`, clips: [["14-remove-hole", 800, 500]] },
    ] },
    { title: "Whole-region tools", note: "Quicker than redrawing when the model was nearly right, or completely wrong.", steps: [
      { id: "slider", nav: "Grow or shrink", title: "Grow or shrink a region",
        text: `Select a region and drag the <b>Grow / shrink</b> slider. The edge moves most where the model was unsure. <b>Reset</b> puts it back.`,
        tip: `The slider redraws the region from the model, so it replaces any changes you made to that region by hand.`, clips: [["15-grow-shrink", 800, 500]] },
      { id: "delete", nav: "Delete a region", title: "Delete a region",
        text: `Select the region and press ${k("Delete")}, or click the <b>Delete</b> button under the list.`, clips: [["16-delete", 800, 500]] },
      { id: "undo", nav: "Undo a mistake", title: "Undo a mistake",
        text: `Click the undo arrow at the top, or press ${k("⌘")} ${k("Z")}. Every change can be undone, one step at a time. The second arrow (${k("⇧")} ${k("⌘")} ${k("Z")}) redoes.`, clips: [["17-undo", 920, 575]] },
      { id: "display", nav: "Check your work", title: "Check your work",
        text: `<b>Fill opacity</b> fades the blue so you can see the tissue underneath. <b>Model's original outline</b> (${k("M")}) shows, as a dashed line, where the model first drew. <b>Probability heatmap</b> (${k("H")}) shows how sure the model was.`, clips: [["18-display", 800, 500]] },
    ] },
    { title: "Finish", note: "Your work is saved by itself as you go.", steps: [
      { id: "done", nav: "Mark done, next image", title: "Mark done and go to the next image",
        text: `Click <b>Mark done</b> (${k("D")}) when an image is finished. The arrows at the top left (or ${k("[")} and ${k("]")}) go to the previous and next image.`, clips: [["19-done-next", 1280, 760]] },
      { id: "export", nav: "Export", title: "Export",
        text: `Click <b>Export</b>. Choose this image or the whole library, the folder to save in, and which files you want. The bar shows progress, and a button opens the folder when it is done.`, clips: [["20-export", 980, 612]] },
    ] },
  ];

  const $ = (id) => document.getElementById(id);
  const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>', PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z"/></svg>';
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let built = false, watcher = null, spy = null;

  function build() {
    built = true;
    let n = 0, nav = "", main = "";
    for (const ch of CHAPTERS) {
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
    main += `<div class="tut-end">That is everything. The <b>Shortcuts</b> button at the top lists every key on one page, and the grey bar along the bottom of the editor always says what the current tool can do.</div>`;
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
