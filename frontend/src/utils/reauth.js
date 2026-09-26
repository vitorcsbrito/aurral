import { reauthApi } from "./api/endpoints/auth.js";

export const isReauthRequiredError = (err) =>
  err?.response?.status === 401 && err?.response?.data?.error === "reauth_required";

// A masked password dialog; window.prompt would show the password in clear
// text. Resolves with the entered password, or null when cancelled.
function askForPassword() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Confirm your password");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);";

    const form = document.createElement("form");
    form.style.cssText =
      "display:flex;flex-direction:column;gap:12px;min-width:280px;max-width:90vw;padding:20px;border-radius:8px;background:var(--color-surface, #1f1f1f);color:inherit;";

    const label = document.createElement("label");
    label.textContent = "Please re-enter your password to continue:";
    label.htmlFor = "aurral-reauth-password";

    const input = document.createElement("input");
    input.id = "aurral-reauth-password";
    input.type = "password";
    input.autocomplete = "current-password";
    input.required = true;

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.className = "btn btn-secondary";
    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.textContent = "Continue";
    confirm.className = "btn btn-primary";
    actions.append(cancel, confirm);

    form.append(label, input, actions);
    overlay.append(form);

    const close = (value) => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") close(null);
    };
    cancel.addEventListener("click", () => close(null));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      close(input.value || null);
    });
    document.addEventListener("keydown", onKeyDown);
    document.body.append(overlay);
    input.focus();
  });
}

export async function promptReauth() {
  const password = await askForPassword();
  if (!password) return false;
  try {
    await reauthApi(password);
    return true;
  } catch (err) {
    window.alert(
      err?.response?.data?.error === "no_local_password"
        ? err.response.data.message ||
            "This account has no local password. Sign out and back in to continue."
        : "That password wasn't correct.",
    );
    return false;
  }
}
