import { createContext, useContext } from 'react';
import { AudioLevelStore } from '../services/audioLevels';

export const AudioLevelsContext = createContext<AudioLevelStore>(new AudioLevelStore());
export const useAudioLevels = () => useContext(AudioLevelsContext);
