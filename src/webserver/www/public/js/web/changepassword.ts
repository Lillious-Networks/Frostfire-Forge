const changePasswordButton = document.getElementById("changepassword-button") as HTMLButtonElement;
const emailInput = document.getElementById("changepassword-email") as HTMLInputElement;
const passwordInput = document.getElementById("changepassword-password") as HTMLInputElement;
const confirmPasswordInput = document.getElementById("changepassword-confirm-password") as HTMLInputElement;

const currentURL = new URL(window.location.href);
const code = currentURL.searchParams.get("code") as string;
const email = currentURL.searchParams.get("email") as string;
if (!code || !email) {
    window.Notify("error", "Invalid or missing code or email");
    window.location.href = "/"; // Redirect to login if code or email is missing
}

emailInput.value = email;
emailInput.disabled = true; // Disable email input since it's pre-filled from the URL

changePasswordButton.addEventListener("click", async () => {
  if (!code) {
    window.Notify("error", "Invalid or missing code");
    return;
  }

  if (passwordInput.value !== confirmPasswordInput.value) {
    window.Notify("error", "Passwords do not match");
    return;
  }

  const response = await fetch("/update-password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: emailInput.value,
      password: passwordInput.value,
      password2: confirmPasswordInput.value,
      code: code,
    }),
  });

  if (response.ok) {
    window.Notify("success", "Password changed successfully. Redirecting to login...");
    // Redirect to login page after a short delay
    setTimeout(() => {
      window.location.href = "/";
    }, 3000);
  } else {
    const data = await response.json();
    const responseMessage = data.message || "Failed to change password";
    window.Notify("error", responseMessage, 7000);
  }
});

// Check for enter key press on the password input
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    changePasswordButton.click();
  }
});