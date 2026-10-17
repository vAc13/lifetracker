# Lifetracker

Personal tracker for sleep, weight, training, habits, goals and money, with a Google Calendar view.

- Live at https://vac13.github.io/lifetracker/ (add it to the iPhone home screen from Safari).
- Data lives in the owner's Google Drive (`Lifetracker/lifetracker-data.json`) and is cached on the device for offline use. Nothing personal is stored in this repository.
- `index.html` is the app, `platform.js` handles Google sign-in, Drive sync and the Calendar API, `sw.js` makes it work offline.
