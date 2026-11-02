# Accents de doublage

Depuis la v0.34.1, le panneau Doublage explique la disponibilité de l’accent selon le moteur, le mode et la langue cible. Ces réglages s’appliquent aux nouveaux essais, individuellement ou par lot. Les essais existants restent conservés.

## VoxCPM2 : retrouver le choix d’accent

VoxCPM2 accepte des consignes de prononciation en **Standard · Ultimate / Hi-Fi désactivé**. Pour un projet dont la langue cible est le français, le menu propose français de France, du Québec, de Belgique ou de Suisse. Ce sont des consignes, sans garantie de reproduction de chaque accent. La sélection de VoxCPM2 depuis un autre moteur démarre maintenant en Standard : elle n’hérite plus du mode avec transcription imposé par Fish ou Audio8, qui activait involontairement Hi-Fi et grisait l’accent. Un choix Hi-Fi déjà enregistré pour VoxCPM2 reste conservé à la réouverture.

**Ultimate / Hi-Fi** utilise l’audio et sa transcription comme continuation ; le modèle officiel désactive alors les consignes séparées. Le guide **hybride** utilise aussi une continuation. Dans ces deux cas, le studio affiche la raison du blocage et le bouton **Activer le choix d’accent · passer en Standard**. Ce bouton désactive Ultimate et le guide hybride éventuel, conserve le fichier de référence, ses limites, les autres réglages et tous les essais. Choisir ensuite l’accent souhaité. Le guide de jeu *analysé* reste compatible avec les consignes d’accent en Standard et peut être réactivé séparément.

Le mode Standard peut conserver moins de détails acoustiques que Hi-Fi. Une référence française nette avec le jeu souhaité aide à concilier accent et expressivité. Avec une référence japonaise, Hi-Fi peut aussi reprendre sa prononciation. Une consigne ne garantit pas la disparition de cet accent.

## Disponibilité selon le moteur intégré

| Moteur / variante du studio | Choix d’accent régional par consigne | Alternative / limite |
| --- | --- | --- |
| CosyVoice3 | Oui, en français | Le studio utilise le mode avec consigne ; pas de garantie d’accent régional. |
| VoxCPM2 Standard | Oui, en français | Compatible avec le guide de jeu analysé. |
| VoxCPM2 Ultimate / Hi-Fi ou guide hybride | Non dans ces modes | Passer explicitement en Standard ou utiliser une référence portant l’accent souhaité. |
| Fish S2 Pro FP8 et GGUF | Oui, en français | Consignes textuelles ; résultat dépendant du modèle et de la référence. |
| Fish Audio Drama 3 FP8 | Oui, en français | Consignes textuelles ; résultat non garanti. |
| Audio8-TTS Realistic 0.6B GGUF | Aucune commande compatible exposée | Le texte guide la langue et la référence guide la prononciation. Choisir une référence dans la langue et avec l’accent souhaités, avec transcription exacte. |
| Qwen3-TTS **Base** 0.6B / 1.7B GGUF | Aucune commande compatible exposée | La langue cible du projet est transmise au moteur. L’accent se guide par la référence. Les interfaces CustomVoice / VoiceDesign concernent d’autres modèles. |
| Chatterbox Multilingual V3 | Aucune commande d’accent régional | La langue cible est transmise au moteur. Référence dans la langue souhaitée recommandée ; CFG à 0 par défaut dans le studio pour limiter le transfert de langue. |

Les quatre consignes régionales du catalogue actuel concernent le français. Pour une autre langue cible, le menu explique cette limite et ne propose pas d’options françaises incompatibles. Pour un moteur sans consigne d’accent, le menu affiche **Accent guidé par la référence vocale**, sans fausses options régionales sélectionnables. Ajouter des instructions dans le texte à prononcer peut les faire lire à voix haute : ce n’est pas un remplacement d’une commande du modèle.

## Sources et qualification

Vérification des interfaces publiques le 2 novembre 2026 : [VoxCPM2 officiel et exclusivité Ultimate / Control Instruction](https://github.com/OpenBMB/VoxCPM/blob/main/app.py), [arguments d’inférence Audio8](https://github.com/Edge0-AI/Audio8_TTS/blob/master/audio8_tts_infer.py), [différence Qwen Base / CustomVoice / VoiceDesign](https://github.com/QwenLM/Qwen3-TTS#usage), [conseils Chatterbox sur le transfert d’accent et CFG](https://github.com/resemble-ai/chatterbox#best-practices-and-recommendations).

Cette version corrige la présentation et l’accès aux réglages déjà pris en charge. Les poids, workers, moteurs natifs et paramètres d’inférence sont inchangés par rapport à la v0.34.0. Les tests d’interface vérifient les neuf variantes, les changements de mode, l’enregistrement, le lot et la conservation des essais ; ils ne constituent pas une évaluation perceptuelle des accents.
