---
name: dive-reel
description: Make an Instagram dive-reel video (descent, swim round, feature stop, ascent) and cover image from a wreck model in the soeglb bucket, using reel/make_reel.py. Use when asked for a reel, flythrough or dive video of a wreck model.
---

# Dive reel

The tool is in `reel/`. Read `reel/README.md` first. It covers the config format, the commands and the look settings.

Steps:

1. Copy `reel/wrecks/euro.json` to `reel/wrecks/<wreck>.json` and set `name` and `model`. The models are at `https://models.southernoceanexploration.com/f/<File>.glb`.
2. Run `python3 reel/make_reel.py survey reel/wrecks/<wreck>.json --draft`, then look at `survey/top-grid.jpg` and the four side views. Work out where the bow and stern are, which side the deck faces, and where the feature is.
3. Write `points` and `keyframes` in model coordinates. Run `preview --draft` and look at `preview.jpg`, and repeat until every still frames the wreck well: no empty sand, no camera inside the hull, close-ups not burnt out by the torch.
4. Check the titles' facts against the Victorian Heritage Database. Don't label a feature as fact if you placed it from the mesh; tell the user how you identified it.
5. Run the full `render` in the background (about 45 minutes), then check stills from the finished mp4 before sending it.
6. Send the mp4 and the cover, and offer a caption: a hook line, what the viewer sees, three or four verified facts with sources, a heritage protection line (look, don't touch), a link to 3dwrecks.southernoceanexploration.com, and hashtags.

Keep the snow and the rest of the look in `render.html`. Don't switch the reel over to the site's viewer, because the viewer shows snow only in VR.
