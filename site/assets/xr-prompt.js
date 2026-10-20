// Shared by /view/ and /ar/.
//
// addBackLink()          puts a small "All wrecks" link in the bottom-left corner.
// showXrPrompt(v, mode)  when the front page sent the visitor here to dive in VR
//                        or AR, shows a big button once the model has loaded.
//                        Browsers only start VR/AR from a tap, so this can't be
//                        automatic. The tap is passed on to the BelowJS button.

const STYLE = `
.soe-back {
    position: fixed; left: 16px; bottom: 16px; z-index: 20;
    padding: 8px 14px; border-radius: 999px;
    background: rgba(10, 25, 40, 0.75); border: 1px solid rgba(127, 163, 186, 0.25);
    color: #cfe4f2; font: 500 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    text-decoration: none; backdrop-filter: blur(8px);
}
.soe-back:hover { background: rgba(20, 45, 70, 0.9); }
.soe-xr {
    position: fixed; inset: 0; z-index: 30;
    display: flex; align-items: center; justify-content: center; padding: 16px;
    background: rgba(0, 10, 20, 0.6); backdrop-filter: blur(4px);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.soe-xr[hidden] { display: none; }
.soe-xr__card {
    max-width: 360px; width: 100%; padding: 28px 24px; border-radius: 16px; text-align: center;
    background: #0a1a2a; border: 1px solid rgba(127, 163, 186, 0.25); color: #cfe4f2;
}
.soe-xr__card h2 { margin: 0 0 8px; font-size: 1.2rem; font-weight: 600; }
.soe-xr__card p { margin: 0 0 20px; color: #7fa3ba; font-size: 0.9rem; line-height: 1.5; }
.soe-xr__go {
    display: block; width: 100%; padding: 14px; border: 0; border-radius: 10px; cursor: pointer;
    background: #2f9fd8; color: #fff; font: 600 1rem/1 inherit;
}
.soe-xr__go:hover { background: #45b0e6; }
.soe-xr__skip {
    margin-top: 12px; padding: 6px; border: 0; background: none; cursor: pointer;
    color: #7fa3ba; font: 0.85rem inherit; text-decoration: underline;
}
`;

function injectStyle() {
    if (document.getElementById('soe-xr-style')) return;
    const style = document.createElement('style');
    style.id = 'soe-xr-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
}

export function addBackLink() {
    injectStyle();
    const link = document.createElement('a');
    link.className = 'soe-back';
    link.href = '/';
    link.textContent = '← All wrecks';
    document.body.appendChild(link);
}

const COPY = {
    vr: {
        heading: 'Ready to dive',
        detail: 'Put on your headset, then tap below to enter the wreck.',
        go: 'Enter VR',
        buttonId: 'VRButton',
        unsupported: 'This browser can’t start VR. Open this page in your headset’s browser.'
    },
    ar: {
        heading: 'Ready for AR',
        detail: 'Once you’re in, point a controller at a table and pull the trigger to put the wreck on it. The thumbstick turns and resizes it.',
        go: 'Start AR',
        buttonId: 'ARButton',
        unsupported: 'This browser can’t start AR. Try a Quest 3 or Chrome on Android.'
    }
};

export function showXrPrompt(viewer, mode) {
    const copy = COPY[mode];
    if (!copy) return;
    injectStyle();

    const overlay = document.createElement('div');
    overlay.className = 'soe-xr';
    overlay.hidden = true;
    overlay.innerHTML = `
        <div class="soe-xr__card" role="dialog" aria-modal="true">
            <h2></h2>
            <p></p>
            <button class="soe-xr__go" type="button"></button>
            <button class="soe-xr__skip" type="button">Stay in browser view</button>
        </div>`;
    overlay.querySelector('h2').textContent = copy.heading;
    const detail = overlay.querySelector('p');
    detail.textContent = copy.detail;
    const go = overlay.querySelector('.soe-xr__go');
    go.textContent = copy.go;
    document.body.appendChild(overlay);

    overlay.querySelector('.soe-xr__skip').addEventListener('click', () => { overlay.hidden = true; });
    go.addEventListener('click', () => {
        const button = document.getElementById(copy.buttonId);
        if (!button || button.disabled) {
            detail.textContent = copy.unsupported;
            go.hidden = true;
            return;
        }
        button.click();
        overlay.hidden = true;
    });

    // Only after the first load, not again when the visitor switches wrecks.
    let shown = false;
    viewer.on('modelLoaded', () => {
        if (shown) return;
        shown = true;
        overlay.hidden = false;
    });
}
