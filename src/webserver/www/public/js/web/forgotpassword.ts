const forgotPasswordButton = document.getElementById("forgotpassword-button") as HTMLButtonElement;
const emailInput = document.getElementById("forgotpassword-email") as HTMLInputElement;
const currentURL = new URL(window.location.href);
const email = currentURL.searchParams.get("email") as string;

// If an email is provided in the URL, set it in the input field
if (email) {
  emailInput.value = email;
}

forgotPasswordButton.addEventListener("click", async () => {
  const response = await fetch("/reset-password", {
    method: "POST",
    body: JSON.stringify({
      email: emailInput.value,
    }),
  });

  const data = await response.json();
  const responseMessage = data.message;

  if (response.ok) {
    window.Notify("success", responseMessage || "Email sent successfully");
  } else {
    window.Notify("error", responseMessage || "Failed to send email");
  }

  emailInput.value = "";
});

// Check for enter key press on the email input
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    forgotPasswordButton.click();
  }
});