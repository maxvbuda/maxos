class Story:
    def __init__(story):
        story.theme = input("Enter the theme of the story: ")
        story.setting = input("Enter the setting of the story: ")
        story.characters = input("Enter the characters of the story: ")
        story.plot = input("Enter the plot of the story: ")
        story.yourname = input("Enter your pen name (if you dont have one, just enter your name): ")

def writing_prompt(story):
    print(f"Write a story about {story.theme} in {story.setting} with {story.characters} as the main characters. The plot should be {story.plot} and the author should be {story.yourname}.")
    story.result = input("Enter your story:")

    with open("writing.txt", "w", encoding="utf-8") as file:
        file.write(story.result)
        file.write(f"Author: {story.yourname}\n")
        file.write(f"Theme: {story.theme}\n")
        file.write(f"Setting: {story.setting}\n")
        file.write(f"Characters: {story.characters}\n")
        file.write(f"Plot: {story.plot}\n")
        file.write(f"Story: {story.result}\n")
my_story = Story()
writing_prompt(my_story)