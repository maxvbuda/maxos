
number = input("enter number: ")
while not number.isdigit():
    number = input("please enter a number. your input was not a number.")
if int(number) % 7 == 0:
    print ("correct!")
else:
    print ("incorrect!")