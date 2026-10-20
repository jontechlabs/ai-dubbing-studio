form Resynthesize a prepared mono take
    sentence Input
    sentence Plan
    sentence Output
endform
Read from file: input$
sound = selected("Sound")
duration = Get total duration
manipulation = To Manipulation: 0.01, 60, 600
Read Table from comma-separated file: plan$
table = selected("Table")
rows = Get number of rows
pitchTier = Create PitchTier: "transfer", 0, duration
durationTier = Create DurationTier: "transfer", 0, duration
pitchPoints = 0
for row from 1 to rows
    selectObject: table
    time = Get value: row, "time"
    frequency = Get value: row, "pitch"
    ratio = Get value: row, "duration"
    if frequency > 0
        selectObject: pitchTier
        Add point: time, frequency
        pitchPoints += 1
    endif
    selectObject: durationTier
    Add point: time, ratio
endfor
if pitchPoints > 0
    selectObject: pitchTier, manipulation
    Replace pitch tier
endif
selectObject: durationTier, manipulation
Replace duration tier
selectObject: manipulation
Get resynthesis (overlap-add)
peak = Get absolute extremum: 0, 0, "None"
if peak > 0.98
    Scale peak: 0.98
endif
Save as WAV file: output$
