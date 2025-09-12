const login = document.getElementById('login-button');
const guestLogin = document.getElementById('guest-login-link') as HTMLAnchorElement;
const username = document.getElementById('username') as HTMLInputElement;
const password = document.getElementById('password') as HTMLInputElement;
username.focus();
if (!login) {
  throw new Error('login-button not found');
}

login.addEventListener('click', async () => {
    const response = await fetch('/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            username: username.value,
            password: password.value
        }),
    });
    if (response.status === 200) {
        window.Notify('success', 'Email sent successfully');
    } else if (response.status === 301) {
        // Player is already verified and logged in
        window.location.href = '/game';
    } else {
        const body = await response.json();
        window.Notify('error', body.message);
    }
});

guestLogin.addEventListener('click', async (event) => {
    event.preventDefault();
    const response = await fetch('/guest-login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
    });
    if (response.status === 301) {
        window.location.href = '/game';
    } else {
        const body = await response.json();
        window.Notify('error', body.message);
    }
});

// Listen for the enter key to click the login button
document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        login.click();
    }
});