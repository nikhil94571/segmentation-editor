/* Tutorial panel: a quick start, then more tools for later. Each step has a short looping clip recorded
   from the real editor (tutorial/make_tutorial.js). Clips load and play only while they are on screen. */
(function () {
  "use strict";
  const DIR = "/viewer/editor/tutorial/";
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
  const k = (s) => `<kbd>${s === "⌘" ? MOD : s}</kbd>`;       // Ctrl on Windows and Linux
  const C = (file, cap) => [file, 800, 500, cap];             // most clips are 800 x 500

  // clip: [file, width, height, optional caption]
  const parts = (hosted) => [
    { title: "Quick start", note: "Eight short steps. Enough to correct an image from start to finish.", chapters: [
      { steps: [
        { id: "open", nav: "The practice images", title: "The practice images are already open",
          text: `Six practice images are loaded, each with a model's blue regions to correct. The arrows at the top left step through them. <b>Open…</b> lists them all: click an image once to preview it, and again to open it.`,
          clips: [["01-open", 1280, 760]] },
        { id: "zoom", nav: "Zoom and move around", title: "Zoom and move around",
          text: `Pinch on a trackpad, or hold ${k("⌘")} and scroll, to zoom in where the pointer is. Drag empty space to move around. <b>Fit</b> shows the whole image again.`,
          tip: `The ${k("+")} and ${k("−")} buttons at the top zoom too.`,
          clips: [["02-zoom", 1280, 760]] },
        { id: "select", nav: "Select a region", title: "Select a region",
          text: `Click a region on the image, or its name in the list on the right. Orange nodes appear on its outline: that is the region you are working on. ${k("N")} steps to the next region, starting with the ones the model was least sure about.`,
          clips: [["03-select", 1042, 650]] },
        { id: "adjust", nav: "Adjust the outline", title: "Adjust the outline",
          text: `With a region selected, <b>drag a node</b> to move that part of the outline, or <b>drag the line</b> between two nodes to bend it.`,
          clips: [C("04-node", "Drag a node"), C("05-bend", "Drag the line to bend it")] },
        { id: "draw", nav: "Draw a new region", title: "Draw a region the model missed",
          text: `Click the pencil on the left, or press ${k("P")}. Press, draw around the area, and finish where you started. The shape fills in when the loop closes.`,
          tip: `Press ${k("V")} (the arrow) to go back to selecting and adjusting.`,
          clips: [C("08-draw")] },
        { id: "reroute", nav: "Extend or trim a region", title: "Extend or trim a region",
          text: `Still with the pencil: start <b>on the outline</b> (an orange dot shows where), draw the new edge, and end back <b>on the same outline</b>. That stretch of the outline is replaced by your line.`,
          clips: [C("11-extend", "Extend <span>· draw the new edge outside the region</span>"), C("12-trim", "Trim <span>· draw through the region; the smaller piece is cut off</span>")] },
        { id: "delete", nav: "Delete, and undo", title: "Delete a wrong region, and undo anything",
          text: `Select a region and press ${k("Delete")} to remove it. If you make a mistake, click the undo arrow at the top or press ${k("⌘")} ${k("Z")}: every change can be undone, one step at a time.`,
          clips: [C("16-delete", "Delete a region"), ["17-undo", 920, 575, "Undo and redo"]] },
        { id: "export", nav: "Save your corrections", title: "Save your corrections",
          text: hosted
            ? `Your work is kept as you go. To take it away, click <b>Export</b>, choose this image or all of them, and tick the file types you want (ImageJ, QuPath, plain masks). They download as one .zip.`
            : `Your work is saved as you go. To get the files, click <b>Export</b>, choose this image or the whole library, the folder to save in, and the file types you want (ImageJ, QuPath, plain masks).`,
          clips: [[hosted ? "20-export-hosted" : "20-export", 980, 612]] },
      ] },
    ] },
    { title: "More tools, for later", later: true, note: "Not needed to get started. Come back to these from the Tutorial button at the top.", chapters: [
      { title: "Finer control of an outline", note: `The Edit tool (the arrow, or ${k("V")}).`, steps: [
        { id: "addnode", nav: "Add or remove a node", title: "Add or remove a node",
          text: `Double-click the line to add a node where you need one, then drag it. Double-click a node to remove it and smooth out a kink.`, clips: [C("06-add-remove-node")] },
        { id: "move", nav: "Move a whole region", title: "Move a whole region",
          text: `Drag from inside the region to slide all of it.`, clips: [C("07-move-region")] },
      ] },
      { title: "More drawing", note: `The Draw tool (the pencil, or ${k("P")}).`, steps: [
        { id: "parts", nav: "Draw in several strokes", title: "Draw in several strokes",
          text: `You can let go part-way. Press the <b>orange end</b> to carry on, and finish on the <b>first node</b> to close the shape.`,
          tip: `${k("Enter")} closes the shape from wherever you are. ${k("Esc")} cancels it.`, clips: [C("09-draw-in-parts")] },
        { id: "undraw", nav: "Fix a slip", title: "Fix a slip while drawing",
          text: `Keep the button down and drag back along your line: it un-draws. Then carry on in the right direction.`,
          tip: `After letting go, ${k("Delete")} removes the last piece of the line.`, clips: [C("10-undraw")] },
        { id: "hole", nav: "Cut a hole", title: "Cut a hole",
          text: `Draw a closed shape <b>inside</b> a region. It becomes a hole.`, clips: [C("13-cut-hole")] },
        { id: "unhole", nav: "Remove a hole", title: "Remove a hole",
          text: `Switch to the Edit tool (${k("V")}). Click inside the hole so it turns orange, then press ${k("Delete")}. Only the hole goes; the region stays.`, clips: [C("14-remove-hole")] },
      ] },
      { title: "Whole-region tools", note: "Quicker than redrawing when the model was nearly right.", steps: [
        { id: "slider", nav: "Grow or shrink", title: "Grow or shrink a region",
          text: `Select a region and drag the <b>Grow / shrink</b> slider. The edge moves most where the model was unsure. <b>Reset</b> puts it back.`,
          tip: `The slider redraws the region from the model, so it replaces any changes you made to that region by hand.`, clips: [C("15-grow-shrink")] },
        { id: "display", nav: "Check your work", title: "Check your work",
          text: `<b>Fill opacity</b> fades the blue so you can see the tissue underneath. <b>Model's original outline</b> (${k("M")}) shows, as a dashed line, where the model first drew. <b>Probability heatmap</b> (${k("H")}) shows how sure the model was.`, clips: [C("18-display")] },
      ] },
      { title: "Working through a set", note: "", steps: [
        { id: "done", nav: "Mark done, next image", title: "Mark done and go to the next image",
          text: `Click <b>Mark done</b> (${k("D")}) when an image is finished. The arrows at the top left (or ${k("[")} and ${k("]")}) go to the previous and next image.`, clips: [["19-done-next", 1280, 760]] },
        { id: "import", nav: "Use your own images", title: "Use your own images",
          text: `In <b>Open…</b>, drop a folder (or a .zip file) onto <b>Upload folder</b>, or click it to choose one. Each image is paired with its model output by file name, for example <span class="mono">slide1_image.png</span> with <span class="mono">slide1_prob.tif</span> or <span class="mono">slide1_mask.png</span>. For just one image, use the <b>Single file</b> tab.`,
          tip: hosted ? `This is a shared demo server: please do not upload confidential or patient images.` : "",
          clips: [["21-import", 1280, 760]] },
      ] },
    ] },
  ];

  const $ = (id) => document.getElementById(id);
  const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>', PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z"/></svg>';
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let built = false, watcher = null, spy = null;

  function build() {
    built = true;
    const hosted = document.documentElement.classList.contains("hosted");
    let n = 0, nav = "", main = `<div class="tut-intro">This editor is for correcting a segmentation model's regions on tissue images: fix an outline, add what the model missed, remove what it got wrong, then export to ImageJ, QuPath or plain masks. <b>The practice images are open behind this panel.</b> Skim the quick start, then press <b>Start practising</b>. You can come back here any time with the <b>Tutorial</b> button at the top.</div>`;
    for (const part of parts(hosted)) {
      nav += `<h5 class="part ${part.later ? "later" : ""}">${part.title}</h5>`;
      main += `<div class="tut-part ${part.later ? "later" : ""}">${part.title}<span>${part.note}</span></div>`;
      for (const ch of part.chapters) {
        if (ch.title) { nav += `<h5>${ch.title}</h5>`; main += `<div class="tut-chap">${ch.title}${ch.note ? `<span>${ch.note}</span>` : ""}</div>`; }
        for (const s of ch.steps) {
          n++;
          nav += `<button type="button" data-go="t-${s.id}"><i>${n}</i><span>${s.nav}</span></button>`;
          main += `<section class="tstep" id="t-${s.id}"><div class="tstep-h"><span class="tnum">${n}</span><h4>${s.title}</h4></div><p>${s.text}</p>${s.tip ? `<p class="tip">${s.tip}</p>` : ""}` +
            s.clips.map(([f, w, h, cap]) => `<div class="tclip">${cap ? `<div class="cap">${cap}</div>` : ""}<div class="tvid" style="aspect-ratio:${w}/${h};max-width:${Math.round(Math.min(760, w))}px">
              <video muted loop playsinline preload="none" poster="${DIR}${f}.jpg" data-src="${DIR}${f}.mp4" aria-label="${s.title}"></video><span class="pp">${PAUSE}</span></div></div>`).join("") + `</section>`;
        }
      }
      if (!part.later) main += `<div class="tut-go"><button class="btn primary" type="button" data-close>Start practising</button><span>That is all you need. The rest is below for later.</span></div>`;
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
