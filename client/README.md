# Client (Camera GUI)

This is a static browser GUI that captures a camera image and sends it to the server endpoint.

## Run the client

From the `client` folder, run any static server. Example with Python:

```bash
python -m http.server 5500
```

Then open:

- `http://localhost:5500`

## API target

Edit the value in `index.html`:

```html
window.APP_CONFIG = { apiBaseUrl: "http://localhost:8787", };
```

Set it to your deployed server URL when moving to production.
