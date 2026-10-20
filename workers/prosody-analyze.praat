form Analyze a prepared mono reference
    sentence Input
    sentence Output
endform
Read from file: input$
sound = selected("Sound")
duration = Get total duration
pitch = To Pitch (ac): 0.01, 60, 15, "no", 0.03, 0.45, 0.01, 0.35, 0.14, 600
writeFileLine: output$, "time,pitch,rms"
steps = ceiling(duration / 0.01)
for frame from 0 to steps
    time = min(duration, frame * 0.01)
    selectObject: pitch
    frequency = Get value at time: time, "Hertz", "Linear"
    if frequency = undefined
        frequency = 0
    endif
    selectObject: sound
    rms = Get root-mean-square: max(0, time - 0.02), min(duration, time + 0.02)
    appendFileLine: output$, time, ",", frequency, ",", rms
endfor
