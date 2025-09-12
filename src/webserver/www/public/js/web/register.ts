const register = document.getElementById('register-button') as HTMLButtonElement;
const email = document.getElementById('register-email') as HTMLInputElement;
email.focus();
const username = document.getElementById('register-username') as HTMLInputElement;
const password = document.getElementById('register-password') as HTMLInputElement;
const password2 = document.getElementById('register-confirm-password') as HTMLInputElement;

if (!register) {
  throw new Error('register not found');
}

register.addEventListener('click', async () => {
  const response = await fetch('/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: email.value,
      username: username.value,
      password: password.value,
      password2: password2.value
    }),
  });

  if (response.status === 200) {
      window.Notify('success', 'Email sent successfully');
  } else if (response.status === 301) {
    window.location.href = '/game';
  } else {
      const body = await response.json();
      window.Notify('error', body.message);
  }
});

// Listen for the enter key to click the register button
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    register.click();
  }
});