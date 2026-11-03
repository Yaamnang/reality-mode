import QRCode from "qrcode";

// "Connect phone" dialog: shows a QR code for this laptop's address on the local network.
export function setupPhoneDialog() {
  const button = document.querySelector<HTMLButtonElement>("#phone-btn")!;
  const dialog = document.querySelector<HTMLDialogElement>("#phone-dialog")!;
  const closeBtn = document.querySelector<HTMLButtonElement>("#phone-close")!;
  const qr = document.querySelector<HTMLCanvasElement>("#phone-qr")!;
  const ipSelect = document.querySelector<HTMLSelectElement>("#phone-ip")!;
  const urlText = document.querySelector<HTMLParagraphElement>("#phone-url")!;

  // Already on the phone (opened via the network address), so no need for the button.
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) {
    button.hidden = true;
    return;
  }

  // A laptop can have several addresses (Wi-Fi, hotspot, virtual adapters). Let the user pick.
  for (const ip of __LAN_IPS__) ipSelect.append(new Option(ip, ip));
  ipSelect.hidden = __LAN_IPS__.length < 2;

  async function render() {
    const ip = ipSelect.value;
    if (!ip) {
      qr.hidden = true;
      urlText.textContent = "No network found. Connect this laptop to Wi-Fi, then restart npm run dev.";
      return;
    }
    const url = `https://${ip}:${__PORT__}`;
    urlText.textContent = url;
    qr.hidden = false;
    await QRCode.toCanvas(qr, url, { width: 220, margin: 1, color: { dark: "#1c2b33", light: "#ffffff" } });
  }

  button.addEventListener("click", () => {
    render();
    dialog.showModal();
  });
  ipSelect.addEventListener("change", render);
  closeBtn.addEventListener("click", () => dialog.close());
  // Click outside the dialog box to close it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}
