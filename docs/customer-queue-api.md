# Customer consultation queue API

Queue tickets apply only to office consultations. The server assigns a daily,
Asia/Manila queue number when authorized staff checks a customer in through the
existing consultation-attendance endpoint. Numbers are generated atomically and
reset for each local calendar date.

## Check in and issue a queue number

`POST /api/v1/appointments/{appointmentId}/consultation-attendance`

Roles: `sales_staff`, `admin`

Request body:

```json
{
  "action": "check_in",
  "actualArrivalAt": "2026-09-27T01:15:00.000Z"
}
```

`actualArrivalAt` is optional and defaults to the server time. A successful
response is `200` and returns the appointment in `data`. Queue fields are:

```json
{
  "queueDate": "2026-09-27",
  "queueSequence": 12,
  "queueNumber": "Q-012",
  "queueIssuedAt": "2026-09-27T01:15:00.000Z"
}
```

An appointment keeps its existing ticket if staff retries a valid check-in;
existing attendance transition and authorization errors still apply.

## Get the signed-in customer's active queue status

`GET /api/v1/appointments/customer-queue`

Role: `customer`

Successful response: `200`.

```json
{
  "success": true,
  "data": {
    "appointmentId": "66f0...",
    "queueNumber": "Q-012",
    "queueDate": "2026-09-27",
    "status": "waiting",
    "position": 3,
    "aheadCount": 2,
    "nowServing": "Q-009",
    "estimatedWaitMinutes": 60,
    "issuedAt": "2026-09-27T01:15:00.000Z",
    "updatedAt": "2026-09-27T01:15:00.000Z"
  }
}
```

`status` is `waiting` or `serving`. `position` is `0` while serving; otherwise
it is `aheadCount + 1`. `estimatedWaitMinutes` uses 30 minutes per waiting
consultation. If the customer has no active ticket for the current local date,
`data` is `null`.

The response sets `Cache-Control: no-store`. Customer clients should refresh on
focus and may poll every 15 seconds while the queue card is visible.
