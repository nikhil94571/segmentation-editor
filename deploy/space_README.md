---
title: Segmentation Editor
emoji: 🔬
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 8080
pinned: false
short_description: Correct a segmentation model's regions on tissue images
---

# Segmentation editor (prototype)

A browser editor for correcting a segmentation model's regions on tissue images and exporting them to ImageJ,
QuPath or plain masks. It opens with six practice images and a short tour.

This is a shared demo: there is no login, and anything uploaded is stored on the server for up to two weeks.
Please do not upload confidential or patient images.

Source and documentation: https://github.com/nikhil94571/segmentation-editor

The practice images are H&E images from Wikimedia Commons (CC0, CC BY-SA 3.0, CC BY-SA 4.0); authors and
source pages are in `data/tissue_2k/SOURCES.json`.
