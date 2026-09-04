# API Lifecycle & State Transitions

## State Transition Diagram
```text
 +---------+        POST /playback/start
 |  IDLE   | -------------------------------------> [ PREPARING ]
 +---------+                                             |
      ^                                                  v
      |                                              [ READY ]
      |                                                  |
      |                                                  v
      |   POST /playback/pause                     +-----------+
      +------------------------------------------- |  RUNNING  | <---+
      |                                            +-----------+     |
      |                                                  |           |
      |        POST /playback/play                       v           |
      +------------------------------------------- +-----------+     |
      |                                            |  PAUSED   | ----+
      |                                            +-----------+
      |   POST /playback/seek                            |
      |                                                  v
      |                                            [  SEEKING  ]
      |                                                  |
      |                                                  v
      |   POST /playback/stop / /reset             (Prior State)
      +------------------------------------------- +-----------+
                                                   |  STOPPED  |
                                                   +-----------+
```
